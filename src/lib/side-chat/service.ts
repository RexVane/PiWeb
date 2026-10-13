import { clampThinkingLevel, type AssistantMessage, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { getManaged } from "../agent-manager";
import { BoundaryError } from "../path-security";
import { getModelRuntime } from "../pi";
import { buildSideChatContext, mainConversationText } from "./context";
import type { SideChatProgress, SideChatRequest, SideChatUsage } from "./types";

const IDLE_MS = 10 * 60_000;
const RUN_MS = 15 * 60_000;
const MAX_RUNNING = 8;

interface SideChatJob {
	progress: SideChatProgress;
	controller: AbortController;
	listeners: Set<() => void>;
	lastSeen: number;
	versions: Map<number, string>;
	publishTimer?: ReturnType<typeof setTimeout>;
}

const globalJobs = globalThis as typeof globalThis & {
	__piWebSideChatJobs?: Map<string, SideChatJob>;
	__piWebSideChatStops?: Map<string, number>;
};
const jobs = globalJobs.__piWebSideChatJobs ??= new Map();
const stopped = globalJobs.__piWebSideChatStops ??= new Map();
const keyOf = (sessionPath: string, requestId: string) => `${sessionPath}\0${requestId}`;

function reapJobs(): void {
	const now = Date.now();
	for (const [key, job] of jobs) {
		if (now - job.lastSeen <= IDLE_MS) continue;
		job.controller.abort();
		if (job.publishTimer) clearTimeout(job.publishTimer);
		for (const notify of job.listeners) notify();
		jobs.delete(key);
	}
	for (const [key, until] of stopped) if (until < now) stopped.delete(key);
}

function publish(job: SideChatJob, terminal = false): void {
	if (job.publishTimer) {
		if (!terminal) return;
		clearTimeout(job.publishTimer);
	}
	const flush = () => {
		job.publishTimer = undefined;
		job.progress = { ...job.progress, revision: job.progress.revision + 1 };
		job.versions.set(job.progress.revision, job.progress.text);
		while (job.versions.size > 8) job.versions.delete(job.versions.keys().next().value!);
		for (const notify of job.listeners) notify();
	};
	if (terminal) flush();
	else job.publishTimer = setTimeout(flush, 80);
}

function settle(job: SideChatJob, update: Partial<SideChatProgress>): void {
	if (job.progress.done) return;
	job.progress = { ...job.progress, ...update, done: true };
	publish(job, true);
}

/** 模型响应里的真实用量；拿不到就返回 undefined（不编数字） */
function usageOf(message: AssistantMessage): SideChatUsage | undefined {
	const usage = message.usage;
	if (!usage) return undefined;
	return { input: usage.input ?? 0, output: usage.output ?? 0, cacheRead: usage.cacheRead ?? 0, cacheWrite: usage.cacheWrite ?? 0 };
}

function assistantText(message: AssistantMessage): string {
	return message.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n\n");
}

/** Creates a separate model call. It never prompts, branches, aborts or saves the main AgentSession. */
export function startSideChat(sessionPath: string, request: SideChatRequest): SideChatProgress {
	reapJobs();
	const key = keyOf(sessionPath, request.requestId);
	const previous = jobs.get(key);
	if (previous) return { ...previous.progress };
	if ([...jobs.values()].filter((job) => !job.progress.done).length >= MAX_RUNNING) throw new BoundaryError("too many side-chat answers are running");
	const managed = getManaged(sessionPath);
	const source = managed.sm.buildSessionContext();
	const selected = managed.session?.model;
	const provider = request.model?.provider ?? selected?.provider ?? source.model?.provider;
	const modelId = request.model?.id ?? selected?.id ?? source.model?.modelId;
	if (!provider || !modelId) throw new BoundaryError("select a model for the side chat first");
	const thinking = managed.session?.thinkingLevel ?? source.thinkingLevel;
	const messages: unknown[] = [...source.messages];
	// A question may refer to the answer currently streaming in the main pane.
	if (managed.inflight && !source.messages.includes(managed.inflight as typeof source.messages[number])) messages.push(managed.inflight);
	const background = mainConversationText(messages);
	const job: SideChatJob = {
		progress: { requestId: request.requestId, revision: 0, text: "", done: false, aborted: false },
		controller: new AbortController(), listeners: new Set(), lastSeen: Date.now(), versions: new Map([[0, ""]]),
	};
	jobs.set(key, job);
	if (stopped.has(key)) {
		settle(job, { aborted: true });
		return { ...job.progress };
	}
	void generate();
	return { ...job.progress };

	async function generate(): Promise<void> {
		const timeout = setTimeout(() => {
			job.controller.abort();
			settle(job, { error: "side-chat request timed out" });
		}, RUN_MS);
		timeout.unref();
		try {
			const runtime = await getModelRuntime();
			if (job.controller.signal.aborted) return;
			const model = runtime.getModel(provider!, modelId!);
			if (!model) throw new BoundaryError("the selected side-chat model is unavailable");
			const built = buildSideChatContext(background, request, model);
			const level = clampThinkingLevel(model, (thinking || "off") as ModelThinkingLevel);
			job.progress = { ...job.progress, model: model.name, contextWindow: model.contextWindow, characters: built.characters, contextTruncated: built.contextTruncated };
			publish(job);
			const stream = runtime.streamSimple(model, built.context, {
				signal: job.controller.signal,
				reasoning: level === "off" ? undefined : level,
				maxTokens: built.maxTokens,
				sessionId: `piweb-sidechat-${request.threadId}`,
				transport: "sse",
			});
			const blocks = new Map<number, string>();
			for await (const event of stream) {
				if (job.progress.done) break;
				if (event.type === "text_delta") {
					blocks.set(event.contentIndex, (blocks.get(event.contentIndex) ?? "") + event.delta);
					job.progress = { ...job.progress, text: [...blocks.entries()].sort(([a], [b]) => a - b).map(([, text]) => text).join("\n\n") };
					publish(job);
				} else if (event.type === "done") {
					const usage = usageOf(event.message);
					settle(job, { text: assistantText(event.message), lengthLimited: event.reason === "length", ...(usage ? { usage } : {}) });
				} else if (event.type === "error") {
					// 出错时的响应里也可能有 usage（比如跑一半被截断），有就记下来
					const usage = usageOf(event.error);
					settle(job, { text: assistantText(event.error), aborted: event.reason === "aborted", error: event.reason === "aborted" ? undefined : event.error.errorMessage || "model request failed", ...(usage ? { usage } : {}) });
				}
			}
			if (!job.progress.done) settle(job, { aborted: job.controller.signal.aborted, error: job.controller.signal.aborted ? undefined : "model stream ended before completion" });
		} catch (error) {
			settle(job, { aborted: job.controller.signal.aborted, error: job.controller.signal.aborted ? undefined : error instanceof Error ? error.message : "side-chat request failed" });
		} finally {
			clearTimeout(timeout);
		}
	}
}

function getJob(sessionPath: string, requestId: string): SideChatJob {
	reapJobs();
	const job = jobs.get(keyOf(sessionPath, requestId));
	if (!job) throw new BoundaryError("side-chat answer expired; send the question again");
	job.lastSeen = Date.now();
	return job;
}

/** Finite JSON responses also work through Cloudflare's buffering quick tunnels. */
export async function pollSideChat(sessionPath: string, requestId: string, after: number, signal: AbortSignal): Promise<SideChatProgress> {
	const job = getJob(sessionPath, requestId);
	if (!job.progress.done && job.progress.revision <= after && !signal.aborted) {
		await new Promise<void>((resolve) => {
			const finish = () => {
				clearTimeout(timer);
				job.listeners.delete(finish);
				signal.removeEventListener("abort", finish);
				resolve();
			};
			const timer = setTimeout(finish, 20_000);
			job.listeners.add(finish);
			signal.addEventListener("abort", finish, { once: true });
			if (signal.aborted || job.progress.done || job.progress.revision > after) finish();
		});
	}
	const previous = job.versions.get(after);
	if (previous !== undefined && job.progress.text.startsWith(previous)) {
		return { ...job.progress, text: job.progress.text.slice(previous.length), textOffset: previous.length };
	}
	return { ...job.progress, textOffset: 0 };
}

export function stopSideChat(sessionPath: string, requestId: string): void {
	const key = keyOf(sessionPath, requestId);
	// Remember an early stop so cancelling while POST is in transit cannot start a late model call.
	stopped.set(key, Date.now() + 60_000);
	const job = jobs.get(key);
	if (!job) return;
	job.controller.abort();
	settle(job, { aborted: true });
}
