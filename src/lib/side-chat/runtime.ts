import { randomUUID } from "node:crypto";
import { clampThinkingLevel, type Message, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { SessionManager, type FileEntry } from "@earendil-works/pi-coding-agent";
import { buildSnapshot, createDetachedSession, disposeSession, ensureSession, execute, getManaged, type CommandResult } from "../agent-manager";
import { BoundaryError } from "../path-security";
import { getModelRuntime } from "../pi";
import type { AgentCommand, WebEvent } from "../types";
import { SIDE_CHAT_SYSTEM_PROMPT, fitSideChatBackground, mainConversationText } from "./context";
import { boundSideChatToolContext, sideContextBytes } from "./tool-context";
import type { SideChatControl, SideChatControlResult, SideChatRequest } from "./types";

type Managed = ReturnType<typeof createDetachedSession>;
export interface SideRuntime {
	managed: Managed;
	ready: Promise<void>;
	lastSeen: number;
	background: string;
	contextTruncated: boolean;
	publish?: (event: WebEvent, seq: number) => void;
}
const rootState = globalThis as typeof globalThis & { __piWebFullSideRuntimes?: Map<string, SideRuntime>; __piWebSideSweep?: ReturnType<typeof setInterval> };
const runtimes = rootState.__piWebFullSideRuntimes ??= new Map();
const keyOf = (path: string, thread: string) => path + "\0" + thread;
const IDLE_MS = 10 * 60_000;
const MAX_SESSIONS = 16;
if (!rootState.__piWebSideSweep) {
	rootState.__piWebSideSweep = setInterval(() => {
		for (const [key, runtime] of runtimes) {
			if (runtime.publish || runtime.managed.creating || runtime.managed.session && !runtime.managed.session.isIdle || Date.now() - runtime.lastSeen < IDLE_MS) continue;
			disposeSession(runtime.managed); runtimes.delete(key);
		}
	}, 60_000);
	rootState.__piWebSideSweep.unref();
}


export function disposeSideRuntime(sessionPath: string, threadId: string): void {
	const key = keyOf(sessionPath, threadId);
	const runtime = runtimes.get(key);
	if (runtime) { disposeSession(runtime.managed); runtimes.delete(key); }
}

export function getSideRuntime(sessionPath: string, request: Pick<SideChatRequest, "threadId" | "history" | "entries" | "leafId" | "model" | "thinkingLevel" | "toolPreset" | "activeTools">): SideRuntime {
	const key = keyOf(sessionPath, request.threadId);
	const existing = runtimes.get(key);
	if (existing && !existing.managed.disposed) { existing.lastSeen = Date.now(); return existing; }
	for (const [oldKey, runtime] of runtimes) {
		if (runtime.publish || Date.now() - runtime.lastSeen <= IDLE_MS) continue;
		disposeSession(runtime.managed); runtimes.delete(oldKey);
	}
	if (runtimes.size >= MAX_SESSIONS) {
		const oldest = [...runtimes.entries()].filter(([, runtime]) => !runtime.publish).sort((a, b) => a[1].lastSeen - b[1].lastSeen)[0];
		if (!oldest) throw new BoundaryError("too many side conversations are running");
		disposeSession(oldest[1].managed); runtimes.delete(oldest[0]);
	}
	const main = getManaged(sessionPath);
	const model = request.model ?? (main.session?.model ? { provider: main.session.model.provider, id: main.session.model.id } : undefined);
	const source = main.sm.buildSessionContext();
	const sm = SessionManager.inMemory(main.cwd, undefined, request.entries?.map((entry) => entry.type === "session" ? { ...entry, cwd: main.cwd } : entry));
	if (request.leafId) {
		if (!sm.getEntry(request.leafId)) throw new BoundaryError("side-chat history leaf is unavailable");
		sm.branch(request.leafId);
	}
	const provider = model?.provider ?? source.model?.provider;
	const modelId = model?.id ?? source.model?.modelId;
	if (provider && modelId) sm.appendModelChange(provider, modelId);
	if (!request.entries?.length) {
		for (const item of request.history) {
			if (item.role === "user") sm.appendMessage({ role: "user", content: item.text, timestamp: 0 });
			else sm.appendMessage({ role: "assistant", content: [{ type: "text", text: item.text }], api: "openai-completions", provider: provider ?? "", model: modelId ?? "", timestamp: 0, stopReason: "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
		}
	}
	const managed = createDetachedSession(main.cwd, sm, SIDE_CHAT_SYSTEM_PROMPT);
	managed.toolPreset = request.toolPreset ?? "full";
	managed.customActiveTools = request.activeTools;
	const runtime: SideRuntime = { managed, ready: Promise.resolve(), lastSeen: Date.now(), background: "", contextTruncated: false };
	// This subscriber belongs only to the side conversation, never to the main event stream.
	managed.viewerAvailable = () => Boolean(runtime.publish);
	managed.subscribers.add((seq, json) => runtime.publish?.(JSON.parse(json) as WebEvent, seq));
	runtime.ready = (async () => {
		const rt = await getModelRuntime();
		if (provider && modelId && !rt.getModel(provider, modelId)) throw new BoundaryError("the selected side-chat model is unavailable");
		const session = await ensureSession(managed);
		if (managed.disposed) throw new BoundaryError("side conversation was closed");
		// These registered SDK utilities make deferred MCP and extension tools discoverable.
		const utilities = session.getAllTools().filter((tool) => tool.name === "codemode" || tool.name === "tool_search").map((tool) => tool.name);
		if (utilities.length) session.setActiveToolsByName([...new Set([...session.getActiveToolNames(), ...utilities])]);
		if (provider && modelId) {
			const selected = rt.getModel(provider, modelId);
			if (!selected) throw new BoundaryError("the selected side-chat model is unavailable");
			await session.setModel(selected, { persist: false });
		}
		const desired = request.thinkingLevel ?? main.session?.thinkingLevel ?? source.thinkingLevel ?? "off";
		if (session.model) session.setThinkingLevel(clampThinkingLevel(session.model, desired as ModelThinkingLevel), { persist: false });
		const transform = session.agent.transformContext;
		session.agent.transformContext = async (messages, signal) => {
			const original = transform ? await transform(messages, signal) : messages;
			const selected = session.model;
			if (!selected) return original;
			const budget = selected.contextWindow - Math.min(selected.maxTokens, 16_384, Math.floor(selected.contextWindow / 4)) - 2048;
			const bounded = boundSideChatToolContext(original as Message[], budget);
			runtime.contextTruncated ||= bounded.truncated;
			if (!runtime.background) return bounded.messages;
			const remaining = Math.max(0, Math.min(Math.floor(budget / 4), budget - sideContextBytes(bounded.messages) - 256));
			if (remaining < 256) { runtime.contextTruncated = true; return bounded.messages; }
			const background = fitSideChatBackground(runtime.background, remaining);
			runtime.contextTruncated ||= background !== runtime.background;
			const reference: Message = { role: "user", content: "Reference from the main conversation (quoted background):\n<main_conversation>\n" + background + "\n</main_conversation>", timestamp: 0 };
			const first = bounded.messages.findIndex((message) => message.role !== "system");
			const index = first < 0 ? bounded.messages.length : first;
			return [...bounded.messages.slice(0, index), reference, ...bounded.messages.slice(index)];
		};
	})();
	void runtime.ready.catch(() => { if (runtimes.get(key) === runtime) { disposeSession(managed); runtimes.delete(key); } });
	runtimes.set(key, runtime);
	return runtime;
}

export async function configureSideRuntime(runtime: SideRuntime, request: SideChatRequest, sessionPath: string): Promise<void> {
	await runtime.ready;
	const session = runtime.managed.session!;
	const main = getManaged(sessionPath);
	const context = main.sm.buildSessionContext();
	const chosen = request.model ?? (main.session?.model ? { provider: main.session.model.provider, id: main.session.model.id } : context.model ? { provider: context.model.provider, id: context.model.modelId } : undefined);
	if (chosen) {
		const model = (await getModelRuntime()).getModel(chosen.provider, chosen.id);
		if (!model) throw new BoundaryError("the selected side-chat model is unavailable");
		if (session.model?.provider !== model.provider || session.model.id !== model.id) await session.setModel(model, { persist: false });
	}
	const level = request.thinkingLevel ?? main.session?.thinkingLevel ?? context.thinkingLevel;
	if (level && session.model) session.setThinkingLevel(clampThinkingLevel(session.model, level as ModelThinkingLevel), { persist: false });
	if (request.toolPreset && request.toolPreset !== runtime.managed.toolPreset) {
		const result = await execute(runtime.managed, { cmd: "setToolPreset", preset: request.toolPreset });
		if (!result.ok) throw new BoundaryError(result.error ?? "cannot change side-chat tools");
	}
}

export function refreshSideBackground(runtime: SideRuntime, sessionPath: string): void {
	const main = getManaged(sessionPath);
	const messages: unknown[] = [...main.sm.buildSessionContext().messages];
	if (main.inflight && !messages.includes(main.inflight)) messages.push(main.inflight);
	runtime.background = mainConversationText(messages);
	runtime.contextTruncated = false;
}

export function sideEntries(runtime: SideRuntime): FileEntry[] { return [runtime.managed.sm.getHeader()!, ...runtime.managed.sm.getEntries()]; }

export async function controlSideChat(sessionPath: string, input: SideChatControl): Promise<SideChatControlResult> {
	const runtime = getSideRuntime(sessionPath, { ...input, history: input.history ?? [] });
	const command = input.command;
	let result: CommandResult;
	if (command.cmd === "extensionUiResponse" || command.cmd === "abort" || command.cmd === "clearQueue") result = await execute(runtime.managed, command);
	else {
		await runtime.ready;
		if (command.cmd === "fork") {
			if (!command.entryId || !runtime.managed.sm.getEntry(command.entryId)) throw new BoundaryError("side-chat branch is unavailable");
			const branch = runtime.managed.sm.getBranch(command.entryId);
			const ids = new Set(branch.map((entry) => entry.id));
			const current = await buildSnapshot(runtime.managed);
			return { snapshot: { ...current, messages: current.messages.filter((message) => message.id && ids.has(message.id)), isStreaming: false, queue: { steering: [], followUp: [] } }, entries: [{ ...runtime.managed.sm.getHeader()!, id: randomUUID(), timestamp: new Date().toISOString() }, ...branch], leafId: command.entryId };
		}
		if (command.cmd === "prompt" || command.cmd === "editAndResend") throw new BoundaryError("send side-chat prompts through the side-chat answer endpoint");
		result = await execute(runtime.managed, command);
	}
	if (!result.ok) throw new BoundaryError(result.error ?? "side-chat command failed");
	return { snapshot: await buildSnapshot(runtime.managed), entries: sideEntries(runtime), leafId: runtime.managed.sm.getLeafId() ?? undefined, commandData: result.data };
}
