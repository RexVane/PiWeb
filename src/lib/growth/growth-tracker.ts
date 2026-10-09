/**
 * growth-tracker：把 pi 会话事件接到「每轮一个 git commit」上。
 *
 * - prepare()（发 prompt 前）：把两轮之间用户自己的修改单独提交一次，不混进 pi 这一轮
 *   （工作区还没有任何提交时记成基线）
 * - agent_start → agent_settled 是一轮：结束时提交本轮，提问首行做标题、用户消息 entryId 写进 trailers；
 *   没有改动也提交空 commit，轮号与对话一一对应
 * 提交失败不影响 pi，只向浏览器报一次错；项目过大 / 没有 git 时本会话停用。
 */
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { GrowthError, commitRound, recordWorkspaceChanges } from "./growth-service";
import { promptsFromEntries } from "./growth-turns";
import type { GrowthRound, GrowthRoundStatus, WebEvent } from "../types";

const ERROR_THROTTLE_MS = 60_000;
export const GROWTH_TRACKER_VERSION = 4;

interface SessionEntryLike {
	type?: string;
	id?: string;
	message?: { role?: string; content?: unknown; stopReason?: string };
}

export interface GrowthTracker {
	version: number;
	getError(): string | null;
	/** 发 prompt 前完成「你的修改」提交，避免它被算进 pi 这一轮 */
	prepare(): Promise<void>;
	onEvent(evt: AgentSessionEvent): void;
	/** 立即记录（项目栏按钮）：把当前改动提交为「你的修改」；没改动返回 null */
	recordNow(): Promise<GrowthRound | null>;
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
}): GrowthTracker {
	const { cwd, sessionPath, publish, entries } = opts;
	let disabled = false;
	let disabledFailure: GrowthError | null = null;
	let disposed = false;
	let lastErrorAt = 0;
	let errorActive = false;
	let lastErrorMessage: string | null = null;
	let chain: Promise<void> = Promise.resolve();
	/** 本轮开始时会话条目的数量；null = 不在一轮之中 */
	let runStart: number | null = null;

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

	return {
		version: GROWTH_TRACKER_VERSION,
		getError: () => lastErrorMessage,
		prepare() {
			if (disabled || disposed) return chain;
			return enqueue(async () => {
				if (disabled || disposed) return;
				published(await recordWorkspaceChanges(cwd, sessionPath));
			});
		},
		onEvent(evt) {
			if (disposed || disabled) return;
			switch (evt.type) {
				case "agent_start":
					// 自动重试会再次 agent_start：一轮只从第一次开始算
					if (runStart === null) runStart = entries().length;
					break;
				case "agent_settled": {
					if (runStart === null) break;
					const all = entries();
					const run = all.slice(runStart);
					const { ids, title } = promptsFromEntries(run);
					runStart = null;
					void enqueue(async () => {
						if (disabled || disposed) return;
						published(await commitRound(cwd, { kind: "round", session: sessionPath, title, promptIds: ids, status: roundStatus(run) }));
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
					result = published(await recordWorkspaceChanges(cwd, sessionPath));
				} catch (error) {
					failure = error;
					reportError(error);
				}
			});
			if (failure) throw failure;
			return result;
		},
		dispose() {
			disposed = true;
		},
	};
}
