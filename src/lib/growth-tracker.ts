/**
 * growth-tracker：把 pi 会话事件接到「每轮一个 git commit」上。
 *
 * - prepare()（发 prompt 前）：把两轮之间用户自己的修改单独提交一次，不混进 pi 这一轮
 *   （工作区还没有任何提交时记成基线）
 * - agent_start → agent_settled 是一轮：结束时提交本轮，提问首行做标题、用户消息 entryId 写进 trailers；
 *   没有改动也提交空 commit，轮号与对话一一对应
 * - 生长记录默认开启，工作区还不是仓库根目录时自动初始化本地仓库；手动停用的工作区不记录。
 *   重新开启时（consentAnswered）可立即拍基线。
 * 提交失败不影响 pi，只向浏览器报一次错；项目过大 / 没有 git 时本会话停用。
 */
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { type CommitOptions, GrowthError, commitRound, recordWorkspaceChanges } from "./growth-service";
import { promptsFromEntries, userTurnsFromEntries } from "./growth-turns";
import type { GrowthRound, GrowthRoundStatus, WebEvent } from "./types";
import { isAbortMessage } from "./chat/cancellation";
import { beginGrowthRun, finishGrowthRun, completeGrowthRun } from "./growth-activity";

const ERROR_THROTTLE_MS = 60_000;
export const GROWTH_TRACKER_VERSION = 7;

interface SessionEntryLike {
	type?: string;
	id?: string;
	message?: { role?: string; content?: unknown; stopReason?: string; errorMessage?: string };
}

export interface GrowthTracker {
	version: number;
	getError(): string | null;
	/** 发 prompt 前完成「你的修改」提交，避免它被算进 pi 这一轮 */
	prepare(): Promise<void>;
	onEvent(evt: AgentSessionEvent): void;
	/** 立即记录（项目栏按钮）：把当前改动提交为「你的修改」；没改动返回 null */
	recordNow(): Promise<GrowthRound | null>;
	/** 更新记录开关（已由调用方保存）：开启时可拍基线，停用时停止后续记录。 */
	consentAnswered(allow: boolean, recordBaseline?: boolean): Promise<GrowthRound | null>;
	dispose(): void;
}

/** 本轮最后一条助手消息的结束原因 → 轮次状态（用户中止 / 模型报错 / 正常） */
function roundStatus(entries: readonly SessionEntryLike[]): GrowthRoundStatus {
	for (let i = entries.length - 1; i >= 0; i -= 1) {
		const message = entries[i].type === "message" ? entries[i].message : undefined;
		if (message?.role !== "assistant") continue;
		if (message.stopReason === "aborted") return "aborted";
		if (message.stopReason === "error") return isAbortMessage(message.errorMessage) ? "aborted" : "error";
		return "done";
	}
	return "done";
}

export function createGrowthTracker(opts: {
	cwd: string;
	sessionPath: string;
	publish: (evt: WebEvent) => void;
	/** 会话的持久条目（SessionManager.getEntries）：轮结束时从中取本轮的提问 */
	entries: () => readonly SessionEntryLike[];
	/** 工作区记录开关：false 停用；null 兼容未保存过选择的旧调用方，默认开启。读取失败应抛错。 */
	consent: () => Promise<boolean | null>;
}): GrowthTracker {
	const { cwd, sessionPath, publish, entries, consent } = opts;
	let disabled = false;
	let disabledFailure: GrowthError | null = null;
	let disposed = false;
	let lastErrorAt = 0;
	let errorActive = false;
	let lastErrorMessage: string | null = null;
	let chain: Promise<void> = Promise.resolve();
	/** 本轮开始时会话条目的数量；null = 不在一轮之中 */
	let runStart: number | null = null;
	/** 每开始一轮加一：prepare 排队期间 pi 已经开工，就不能再把工作区记成「你的修改」 */
	let runEpoch = 0;
	const releaseActiveRun = () => {
		const attribution = finishGrowthRun(cwd, sessionPath);
		runStart = null;
		void completeGrowthRun(cwd, attribution.runId).catch((error) => console.warn("[piweb] Could not finish project recording activity", error));
	};

	// 提交失败不打扰用户（项目栏退化成普通文件树 + 查看器）：只在服务端日志记一次，没 git / 项目过大就停用本会话的跟踪
	const reportError = (error: unknown) => {
		const message = error instanceof Error ? error.message : String(error);
		const terminal = error instanceof GrowthError && (error.code === "unavailable" || error.code === "too-large");
		if (terminal) {
			disabled = true;
			disabledFailure = error;
			releaseActiveRun();
		}
		errorActive = true;
		lastErrorMessage = message;
		const now = Date.now();
		if (!terminal && now - lastErrorAt < ERROR_THROTTLE_MS) return;
		lastErrorAt = now;
		console.warn(`[piweb] growth commit failed for ${cwd}: ${message}`);
		publish({ type: "growth_error", message, ts: now });
	};

	const enqueue = (fn: () => Promise<void>) => {
		chain = chain.then(fn, fn).catch(reportError);
		return chain;
	};

	const published = (round: GrowthRound | null) => {
		if (errorActive) {
			errorActive = false;
			lastErrorMessage = null;
			publish({ type: "growth_error", message: null, ts: Date.now() });
		}
		if (round && !disposed) publish({ type: "growth", round, ts: Date.now() });
		return round;
	};

	const declined = () => {
		disabled = true;
		disabledFailure = new GrowthError("growth tracking was declined for this workspace", "unavailable");
		releaseActiveRun();
	};

	/** 默认记录；明确停用时跳过。开关读取失败交给错误处理，不能当成默认值。 */
	const commit = async (run: (options: CommitOptions) => Promise<GrowthRound | null>, abortIf?: () => boolean): Promise<GrowthRound | null | undefined> => {
		const decision = await consent();
		if (decision === false) {
			declined();
			return undefined;
		}
		return run({ allowInit: true, allowRecording: true, abortIf });
	};

	const recordUserChanges = (abortIf?: () => boolean) =>
		commit((options) => recordWorkspaceChanges(cwd, sessionPath, options), abortIf);

	return {
		version: GROWTH_TRACKER_VERSION,
		getError: () => lastErrorMessage,
		prepare() {
			if (disabled || disposed) return chain;
			const epoch = runEpoch;
			return enqueue(async () => {
				if (disabled || disposed) return;
				// 5 秒没拍完提问就放行了：pi 开工后再拍的快照会把它的改动记成「你的修改」
				const round = await recordUserChanges(() => runEpoch !== epoch);
				if (round !== undefined) published(round);
			});
		},
		onEvent(evt) {
			if (disposed || disabled) return;
			switch (evt.type) {
				case "agent_start":
					// 自动重试会再次 agent_start：一轮只从第一次开始算
					if (runStart === null) {
						beginGrowthRun(cwd, sessionPath);
						runStart = entries().length;
						runEpoch += 1;
					}
					break;
				case "agent_settled": {
					if (runStart === null) break;
					const all = entries();
					const run = all.slice(runStart);
					const { ids, title } = promptsFromEntries(run);
					const ordinal = userTurnsFromEntries(all).findIndex((turn) => turn.id === ids[0]) + 1;
					const attribution = finishGrowthRun(cwd, sessionPath);
					runStart = null;
					void enqueue(async () => {
						try {
							if (disabled || disposed) return;
							const round = await commit((options) => commitRound(cwd, { kind: "round", session: sessionPath, title, promptIds: ids, ...(ordinal > 0 ? { roundNumber: ordinal } : {}), status: roundStatus(run), ...attribution }, options));
							if (round !== undefined) published(round);
						} finally { await completeGrowthRun(cwd, attribution.runId); }
					});
					break;
				}
				default:
					break;
			}
		},
		async recordNow() {
			if (disabled) throw disabledFailure ?? new GrowthError("growth tracking is disabled for this workspace", "unavailable");
			let result: GrowthRound | null = null;
			let failure: unknown;
			await enqueue(async () => {
				try {
					if (disabled) throw disabledFailure ?? new GrowthError("growth tracking is disabled for this workspace", "unavailable");
					const round = await recordUserChanges();
					if (round === undefined) {
						throw disabled
							? disabledFailure ?? new GrowthError("growth tracking is disabled for this workspace", "unavailable")
							: new GrowthError("growth tracking is disabled for this workspace", "unavailable");
					}
					result = published(round);
				} catch (error) {
					failure = error;
					if (!(error instanceof GrowthError && error.code === "needs-consent")) reportError(error);
				}
			});
			if (failure) throw failure;
			return result;
		},
		async consentAnswered(allow, recordBaseline = true) {
			if (!allow) {
				declined();
				return null;
			}
			if (disposed) return null;
			disabled = false;
			disabledFailure = null;
			if (!recordBaseline) return null;
			let result: GrowthRound | null = null;
			await enqueue(async () => {
				const round = await recordUserChanges();
				result = round === undefined ? null : published(round);
			});
			return result;
		},
		dispose() {
			disposed = true;
			releaseActiveRun();
		},
	};
}
