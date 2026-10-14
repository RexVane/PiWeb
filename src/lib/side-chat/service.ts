import { runAgentLoopContinue } from "@earendil-works/pi-agent-core";
import { createReadOnlyTools } from "@earendil-works/pi-coding-agent";
import { clampThinkingLevel, normalizeContext, type AssistantMessage, type Message, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { getManaged } from "../agent-manager";
import { BoundaryError } from "../path-security";
import { getModelRuntime, presetAllowsTool } from "../pi";
import { buildSideChatContext, mainConversationText } from "./context";
import { boundSideChatToolContext } from "./tool-context";
import type { SideChatProgress, SideChatRequest, SideChatUsage } from "./types";

const IDLE_MS = 10 * 60_000;
const RUN_MS = 15 * 60_000;
const MAX_RUNNING = 8;
const MAX_MODEL_CALLS = 32;

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
	job.progress = { ...job.progress, ...update, activeTool: null, done: true };
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

/** Runs an independent read-only agent. Never prompts, branches, aborts or saves the main AgentSession. */
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
			const tools = createReadOnlyTools(managed.cwd).filter((tool) => presetAllowsTool("readonly", tool.name));
			const built = buildSideChatContext(background, request, model, { tools, cwd: managed.cwd });
			const level = clampThinkingLevel(model, (thinking || "off") as ModelThinkingLevel);
			job.progress = { ...job.progress, model: model.name, contextWindow: model.contextWindow, characters: built.characters, contextTruncated: built.contextTruncated };
			publish(job);
			let completedText = "";
			let calls = 0;
			await runAgentLoopContinue({ messages: normalizeContext(built.context).messages, tools }, {
				model,
				convertToLlm: (messages) => messages as Message[],
				reasoning: level === "off" ? undefined : level,
				maxTokens: built.maxTokens,
				sessionId: `piweb-sidechat-${request.threadId}`,
				transport: "sse",
				prepareRequest: () => {
					if (job.progress.done || job.controller.signal.aborted) throw new BoundaryError("side-chat answer stopped");
					if (++calls > MAX_MODEL_CALLS) throw new BoundaryError("side-chat tool-call limit reached; narrow the question and try again");
				},
				transformContext: async (messages) => {
					const bounded = boundSideChatToolContext(messages as Message[], model.contextWindow - built.maxTokens - 1024);
					if (bounded.truncated) { job.progress = { ...job.progress, contextTruncated: true }; publish(job); }
					return bounded.messages;
				},
				beforeToolCall: async (_, signal) => signal?.aborted || job.progress.done ? { block: true, terminate: true, reason: "Side-chat answer stopped" } : undefined,
			}, (event) => {
				if (job.progress.done) return;
				if (event.type === "message_update" && event.message.role === "assistant") {
					job.progress = { ...job.progress, text: [completedText, assistantText(event.message)].filter(Boolean).join("\n\n") };
					publish(job);
				} else if (event.type === "message_end" && event.message.role === "assistant") {
					const message = event.message;
					completedText = [completedText, assistantText(message)].filter(Boolean).join("\n\n");
					const usage = usageOf(message);
					job.progress = { ...job.progress, text: completedText, ...(usage ? { usage } : {}), lengthLimited: message.stopReason === "length" };
					publish(job);
					if (message.stopReason === "error" || message.stopReason === "aborted") settle(job, { aborted: message.stopReason === "aborted", error: message.stopReason === "aborted" ? undefined : message.errorMessage || "model request failed" });
				} else if (event.type === "tool_execution_start") {
					job.progress = { ...job.progress, activeTool: event.toolName };
					publish(job);
				} else if (event.type === "tool_execution_end") {
					job.progress = { ...job.progress, activeTool: null };
					publish(job);
				}
			}, job.controller.signal, (currentModel, context, options) => runtime.streamSimple(currentModel, context, options));
			if (!job.progress.done) settle(job, { aborted: job.controller.signal.aborted });
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
