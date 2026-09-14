/**
 * growth-tracker：把 pi 会话事件接到项目生长快照引擎上。
 *
 * - agent_start：确保本会话有基线步，并启动工作区目录监听
 * - 改盘类工具（bash / powershell / write / edit / 未知扩展工具）结束：去抖 200ms 拍一张快照（并行工具合并成一步）
 * - agent_end：兜底再拍一次（tree 没变就不记步）
 * - 目录监听：改盘类工具运行期间看到的新路径先以「生成中」推给浏览器；空闲时的改动去抖 1.5s 记成「外部修改」
 * 快照失败不影响 pi，只向浏览器报一次错；项目过大 / 没有 git 时本会话停用。
 */
import fs from "node:fs";
import { realpathSync } from "node:fs";
import path from "node:path";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { GrowthError, hasSessionSteps, isExcludedRelPath, snapshot } from "./growth-service";
import type { GrowthStep, GrowthStepKind, WebEvent } from "./types";

const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);
const SNAPSHOT_DEBOUNCE_MS = 200;
const PENDING_THROTTLE_MS = 300;
const EXTERNAL_DEBOUNCE_MS = 1500;
const MAX_PENDING = 500;
const ERROR_THROTTLE_MS = 60_000;
export const GROWTH_TRACKER_VERSION = 3;

interface QueuedMeta {
	kind: GrowthStepKind;
	label: string;
	toolCallId?: string;
	toolName?: string;
}

export interface GrowthTracker {
	version: number;
	getError(): string | null;
	/** 在首轮 prompt 前完成基线，避免快速写盘被误算进基线。 */
	prepare(): Promise<void>;
	onEvent(evt: AgentSessionEvent): void;
	/** 手动快照（API 触发）；返回记下的步，tree 没变返回 null */
	snapshotNow(label?: string): Promise<GrowthStep | null>;
	dispose(): void;
}

export function isMutatingTool(name: string): boolean {
	return !READ_ONLY_TOOLS.has(name.toLowerCase());
}

/** 「bash · mkdir -p src」：工具名 + 命令首行 / 相对路径，截到 60 字 */
export function labelForTool(cwd: string, name: string, args: unknown): string {
	const a = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
	let detail = "";
	if (typeof a.command === "string") detail = a.command;
	else if (typeof a.path === "string") detail = relativeToCwd(cwd, a.path);
	else if (typeof a.file_path === "string") detail = relativeToCwd(cwd, a.file_path);
	detail = detail.split("\n").map((s) => s.trim()).find(Boolean) ?? "";
	detail = detail.replace(/\s+/g, " ");
	if (detail.length > 60) detail = `${detail.slice(0, 59)}…`;
	return detail ? `${name} · ${detail}` : name;
}

function relativeToCwd(cwd: string, p: string): string {
	if (!path.isAbsolute(p)) return p.replace(/\\/g, "/");
	const rel = path.relative(cwd, p);
	if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return p.replace(/\\/g, "/");
	return rel.replace(/\\/g, "/");
}

/** 工具链自动生成/频繁改写的文件：进 pending 只会制造蓝点噪音，快照侧由 .gitignore 与影子仓库 exclude 兜底 */
const WATCHER_FILE_NOISE = /(?:^|\/)(?:\.DS_Store|Thumbs\.db|[^/]*\.log|[^/]*\.tsbuildinfo|next-env\.d\.ts)$/;

export function createGrowthTracker(opts: { cwd: string; sessionPath: string; publish: (evt: WebEvent) => void }): GrowthTracker {
	const { cwd, sessionPath, publish } = opts;
	const running = new Set<string>();
	const argsById = new Map<string, unknown>();
	const queue: QueuedMeta[] = [];
	const pending = new Set<string>();
	let pendingStats = 0;
	let flushTimer: ReturnType<typeof setTimeout> | undefined;
	let pendingTimer: ReturnType<typeof setTimeout> | undefined;
	let externalTimer: ReturnType<typeof setTimeout> | undefined;
	let watcher: fs.FSWatcher | null = null;
	let watcherFailed = false;
	let baselineChecked = false;
	let baselinePending: Promise<void> | null = null;
	let disabled = false;
	let disabledFailure: GrowthError | null = null;
	let disposed = false;
	let lastErrorAt = 0;
	let errorActive = false;
	let lastErrorMessage: string | null = null;
	let chain: Promise<void> = Promise.resolve();

	// 快照失败不打扰用户（项目栏退化成普通文件树 + 查看器）：只在服务端日志记一次，没 git / 项目过大就停用本会话的跟踪
	const reportError = (error: unknown) => {
		const message = error instanceof Error ? error.message : String(error);
		const terminal = error instanceof GrowthError && (error.code === "unavailable" || error.code === "too-large");
		if (terminal) {
			disabled = true;
			disabledFailure = error;
			try {
				watcher?.close();
			} catch {
				/* ignore watcher close errors after a terminal snapshot failure */
			}
			watcher = null;
			if (flushTimer) clearTimeout(flushTimer);
			if (pendingTimer) clearTimeout(pendingTimer);
			if (externalTimer) clearTimeout(externalTimer);
			flushTimer = pendingTimer = externalTimer = undefined;
			queue.length = 0;
			running.clear();
			argsById.clear();
			if (pending.size) {
				pending.clear();
				publish({ type: "growth_pending", paths: [], ts: Date.now() });
			}
		}
		errorActive = true;
		lastErrorMessage = message;
		const now = Date.now();
		if (!terminal && now - lastErrorAt < ERROR_THROTTLE_MS) return;
		lastErrorAt = now;
		console.warn(`[piweb] growth snapshot failed for ${cwd}: ${message}`);
		publish({ type: "growth_error", message, ts: now });
	};

	const publishPending = () => {
		pendingTimer = undefined;
		publish({ type: "growth_pending", paths: [...pending].slice(0, 200), ts: Date.now() });
	};

	const enqueue = (fn: () => Promise<void>) => {
		chain = chain.then(fn, fn).catch(reportError);
		return chain;
	};

	// 真正拍快照的函数不能再 enqueue（链上任务里嵌套排队会等自己，整条链永久卡死）
	const doRecord = async (meta: QueuedMeta, force = false) => {
		if (disabled || disposed) return;
		const step = await snapshot(cwd, { ...meta, session: sessionPath, force });
		if (errorActive) {
			errorActive = false;
			lastErrorMessage = null;
			publish({ type: "growth_error", message: null, ts: Date.now() });
		}
		if (!step || disposed) return;
		publish({ type: "growth", step, ts: Date.now() });
		if (pending.size) {
			pending.clear();
			if (pendingTimer) clearTimeout(pendingTimer);
			publishPending();
		}
	};
	const record = (meta: QueuedMeta, force = false) => enqueue(() => doRecord(meta, force));

	const ensureBaseline = (): Promise<void> => {
		if (baselineChecked) return chain;
		if (baselinePending) return baselinePending;
		baselinePending = enqueue(async () => {
			if (disabled || disposed) return;
			if (!(await hasSessionSteps(cwd, sessionPath))) await doRecord({ kind: "baseline", label: "" }, true);
			baselineChecked = true;
		});
		void baselinePending.finally(() => { baselinePending = null; });
		return baselinePending;
	};

	const flush = () => {
		flushTimer = undefined;
		const metas = queue.splice(0);
		if (!metas.length) return;
		const tools = metas.filter((x) => x.kind === "tool");
		const head = tools[0] ?? metas[0];
		const extra = tools.length > 1 ? ` +${tools.length - 1}` : "";
		void record({ kind: head.kind, label: `${head.label}${extra}`, toolCallId: head.toolCallId, toolName: head.toolName });
	};

	const schedule = (meta: QueuedMeta) => {
		if (disabled) return;
		if (externalTimer) {
			clearTimeout(externalTimer);
			externalTimer = undefined;
		}
		queue.push(meta);
		if (flushTimer) clearTimeout(flushTimer);
		flushTimer = setTimeout(flush, SNAPSHOT_DEBOUNCE_MS);
	};

	const onFsChange = (_type: string, filename: string | Buffer | null) => {
		if (disabled || disposed) return;
		const rel = filename == null ? "" : String(filename).replace(/\\/g, "/");
		if (rel && (isExcludedRelPath(rel) || WATCHER_FILE_NOISE.test(rel))) return;
		if (running.size > 0) {
			if (!rel || pending.size + pendingStats >= MAX_PENDING) return;
			pendingStats += 1;
			// fs.watch 回调不能同步 stat；目录标记允许异步到达。
			void fs.promises.stat(path.join(cwd, rel)).then(
				(info) => info.isDirectory(),
				() => false,
			).then((isDir) => {
				if (disposed || disabled) return;
				const livePath = isDir ? `${rel}/` : rel;
				if (pending.size >= MAX_PENDING || pending.has(livePath)) return;
				pending.add(livePath);
				if (!pendingTimer) pendingTimer = setTimeout(publishPending, PENDING_THROTTLE_MS);
			}).finally(() => { pendingStats -= 1; });
			return;
		}
		// 工具刚结束、快照还没拍：这次改动归它，不另记外部修改
		if (queue.length || flushTimer) return;
		if (externalTimer) clearTimeout(externalTimer);
		externalTimer = setTimeout(() => {
			externalTimer = undefined;
			if (running.size > 0 || queue.length) return;
			void record({ kind: "external", label: "" });
		}, EXTERNAL_DEBOUNCE_MS);
	};

	const startWatcher = () => {
		if (watcher || watcherFailed || disabled) return;
		try {
			// Watch the canonical path: on Windows an 8.3 short name (RUNNER~1) can make
			// libuv's directory watcher compare mismatched spellings and crash the process.
			let watchRoot = cwd;
			try {
				watchRoot = realpathSync.native(cwd);
			} catch {
				/* keep the given path when it cannot be resolved */
			}
			watcher = fs.watch(watchRoot, { recursive: true, persistent: false }, onFsChange);
			watcher.on("error", () => {
				watcherFailed = true;
				try {
					watcher?.close();
				} catch {
					/* ignore */
				}
				watcher = null;
			});
		} catch {
			watcherFailed = true;
			watcher = null;
		}
	};

	return {
		version: GROWTH_TRACKER_VERSION,
		getError: () => lastErrorMessage,
		async prepare() {
			startWatcher();
			await ensureBaseline();
		},
		onEvent(evt) {
			if (disposed || disabled) return;
			switch (evt.type) {
				case "agent_start":
					startWatcher();
					void ensureBaseline();
					break;
				case "tool_execution_start": {
					if (!isMutatingTool(evt.toolName)) break;
					running.add(evt.toolCallId);
					if (argsById.size > 64) argsById.delete(argsById.keys().next().value as string);
					argsById.set(evt.toolCallId, (evt as { args?: unknown }).args);
					if (externalTimer) {
						clearTimeout(externalTimer);
						externalTimer = undefined;
					}
					break;
				}
				case "tool_execution_end": {
					if (!isMutatingTool(evt.toolName)) break;
					running.delete(evt.toolCallId);
					const args = argsById.get(evt.toolCallId);
					argsById.delete(evt.toolCallId);
					schedule({ kind: "tool", label: labelForTool(cwd, evt.toolName, args), toolCallId: evt.toolCallId, toolName: evt.toolName });
					break;
				}
				case "agent_end":
					running.clear();
					// 先落下本轮最后一批工具快照，再写不依赖文件变化的轮次终点。
					if (flushTimer) clearTimeout(flushTimer);
					flush();
					// 无文件变更的回合也持久化终点，轮数才能与真实用户轮次一致。
					if (!evt.willRetry) void enqueue(() => doRecord({ kind: "turn", label: "" }, true));
					break;
				default:
					break;
			}
		},
		async snapshotNow(label = "") {
			if (disabled) throw disabledFailure ?? new GrowthError("growth tracking is disabled for this workspace", "unavailable");
			let result: GrowthStep | null = null;
			let failure: unknown;
			await enqueue(async () => {
				try {
					if (disabled) throw disabledFailure ?? new GrowthError("growth tracking is disabled for this workspace", "unavailable");
					const step = await snapshot(cwd, { kind: "manual", label, session: sessionPath });
					if (errorActive) {
						errorActive = false;
						lastErrorMessage = null;
						publish({ type: "growth_error", message: null, ts: Date.now() });
					}
					if (step) {
						result = step;
						publish({ type: "growth", step, ts: Date.now() });
					}
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
			if (flushTimer) clearTimeout(flushTimer);
			if (pendingTimer) clearTimeout(pendingTimer);
			if (externalTimer) clearTimeout(externalTimer);
			try {
				watcher?.close();
			} catch {
				/* ignore */
			}
			watcher = null;
		},
	};
}
