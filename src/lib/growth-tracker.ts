/**
 * growth-tracker：把 pi 会话事件接到「每轮一个 git commit」上。
 *
 * - prepare()（发 prompt 前）：把两轮之间用户自己的修改单独提交一次，不混进 pi 这一轮
 *   （工作区还没有任何提交时记成基线）
 * - agent_start → agent_settled 是一轮：结束时提交本轮，提问首行做标题、用户消息 entryId 写进 trailers；
 *   没有改动也提交空 commit，轮号与对话一一对应
 * - 工作区还不是仓库根目录时，要先征得同意才 `git init`：没决定就向浏览器发一次 growth_consent 并暂不记录，
 *   拒绝了就停用；同意后（consentAnswered）立即拍基线
 * 提交失败不影响 pi，只向浏览器报一次错；项目过大 / 没有 git 时本会话停用。
 */
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { type CommitOptions, GrowthError, commitRound, recordWorkspaceChanges } from "./growth-service";
import { promptsFromEntries } from "./growth-turns";
import type { GrowthConsentRequest, GrowthRound, GrowthRoundStatus, WebEvent } from "./types";

const ERROR_THROTTLE_MS = 60_000;
export const GROWTH_TRACKER_VERSION = 5;

interface SessionEntryLike {
	type?: string;
	id?: string;
	message?: { role?: string; content?: unknown; stopReason?: string };
}

export interface GrowthTracker {
	version: number;
	getError(): string | null;
	/** 等用户回答的建仓库请求（快照里带上，页面重开也能看到） */
	getConsentRequest(): GrowthConsentRequest | null;
	/** 发 prompt 前完成「你的修改」提交，避免它被算进 pi 这一轮 */
	prepare(): Promise<void>;
	onEvent(evt: AgentSessionEvent): void;
	/** 立即记录（项目栏按钮）：把当前改动提交为「你的修改」；没改动返回 null */
	recordNow(): Promise<GrowthRound | null>;
	/** 用户回答了建仓库请求（决定已由调用方存好）：同意就立即拍基线，拒绝就停用 */
	consentAnswered(allow: boolean): Promise<GrowthRound | null>;
	dispose(): void;
}

/** 本轮最后一条助手消息的结束原因 → 轮次状态（用户中止 / 模型报错 / 正常） */
function roundStatus(entries: readonly SessionEntryLike[]): GrowthRoundStatus {
	for (let i = entries.length - 1; i >= 0; i -= 1) {
		const message = entries[i].type === "message" ? entries[i].message : undefined;
		if (message?.role !== "assistant") continue;
		if (message.stopReason === "aborted") return "aborted";
		if (message.stopReason === "error") return "error";
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
	/** 该工作区是否同意建仓库：true 同意 / false 拒绝 / null 还没问过 */
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
	/** 已知工作区要先建仓库；consentRequest = 正在等用户回答 */
	let needsInit = false;
	let consentRequest: GrowthConsentRequest | null = null;

	// 提交失败不打扰用户（项目栏退化成普通文件树 + 查看器）：只在服务端日志记一次，没 git / 项目过大就停用本会话的跟踪
	const reportError = (error: unknown) => {
		const message = error instanceof Error ? error.message : String(error);
		const terminal = error instanceof GrowthError && (error.code === "unavailable" || error.code === "too-large");
		if (terminal) {
			disabled = true;
			disabledFailure = error;
			runStart = null;
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
		runStart = null;
	};

	/**
	 * 带同意检查地提交：返回 undefined 表示这次没提交（还在等同意 / 已拒绝）。
	 * 已知要建仓库且还没决定时直接跳过，不再每轮起一个 git 进程去探测。
	 */
	const commit = async (run: (options: CommitOptions) => Promise<GrowthRound | null>, abortIf?: () => boolean): Promise<GrowthRound | null | undefined> => {
		const decision = needsInit ? await consent() : null;
		if (decision === false) {
			declined();
			return undefined;
		}
		if (needsInit && decision === null) return undefined;
		try {
			return await run({ allowInit: decision === true, abortIf });
		} catch (error) {
			if (!(error instanceof GrowthError) || error.code !== "needs-consent") throw error;
			needsInit = true;
			const answer = await consent();
			if (answer === false) {
				declined();
				return undefined;
			}
			if (answer === true) return run({ allowInit: true, abortIf });
			if (!consentRequest && !disposed) {
				consentRequest = { cwd, reason: error.target?.reason ?? "not-git", parent: error.target?.parent };
				publish({ type: "growth_consent", request: consentRequest, ts: Date.now() });
			}
			return undefined;
		}
	};

	const recordUserChanges = (abortIf?: () => boolean) =>
		commit((options) => recordWorkspaceChanges(cwd, sessionPath, options), abortIf);

	return {
		version: GROWTH_TRACKER_VERSION,
		getError: () => lastErrorMessage,
		getConsentRequest: () => consentRequest,
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
						runStart = entries().length;
						runEpoch += 1;
					}
					break;
				case "agent_settled": {
					if (runStart === null) break;
					const all = entries();
					const run = all.slice(runStart);
					const { ids, title } = promptsFromEntries(run);
					runStart = null;
					void enqueue(async () => {
						if (disabled || disposed) return;
						const round = await commit((options) => commitRound(cwd, { kind: "round", session: sessionPath, title, promptIds: ids, status: roundStatus(run) }, options));
						if (round !== undefined) published(round);
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
							: new GrowthError("growth tracking is waiting for permission to create a git repository", "needs-consent");
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
		async consentAnswered(allow) {
			const pending = consentRequest;
			consentRequest = null;
			if (pending && !disposed) publish({ type: "growth_consent", request: null, ts: Date.now() });
			if (!allow) {
				declined();
				return null;
			}
			if (disabled || disposed) return null;
			let result: GrowthRound | null = null;
			await enqueue(async () => {
				const round = await recordUserChanges();
				result = round === undefined ? null : published(round);
			});
			return result;
		},
		dispose() {
			disposed = true;
		},
	};
}
