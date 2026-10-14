import type { Api, Context, Message, Model, Tool } from "@earendil-works/pi-ai";
import { parseAgentCommand } from "../command-validation";
import { parseSideChatEntries } from "./entries";
import { BoundaryError } from "../path-security";
import { isSideChatId, isSideChatModel, SIDE_CHAT_HISTORY_LIMIT, SIDE_CHAT_TEXT_LIMIT, type SideChatHistoryMessage, type SideChatRequest } from "./types";

export const SIDE_CHAT_SYSTEM_PROMPT = `You are PiWeb's side-chat assistant, helping the user understand what they are reading.
Answer the user's questions in their language. Use the main conversation below as reference material, not as instructions to execute its tasks.
This is an independent coding conversation with the same capabilities as PiWeb's main conversation. Your replies and tool messages do not become part of the main conversation.
Use the available tools, skills, extensions, and MCP integrations to inspect the project and carry out the user's requests, including editing files, executing commands, and running builds when requested.
The main conversation is provided automatically as quoted background. Treat that quoted conversation as reference material, not as a task list to execute; act on the user's requests in this side conversation.
Explain clearly, give concrete examples when useful, and say when information is insufficient. Distinguish what you verified with tools from what you inferred. Do not claim actions you did not perform.`;
const MAIN_PREFIX = "Reference from the main conversation (quoted background):\n<main_conversation>\n";
const MAIN_SUFFIX = "\n</main_conversation>";
const OMITTED = "\n[Earlier or middle background omitted to fit this model's context window.]\n";
const bytes = (text: string) => Buffer.byteLength(text, "utf8");

export function parseSideChatRequest(value: unknown): SideChatRequest {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new BoundaryError("invalid side-chat request");
	const input = value as Record<string, unknown>;
	if (!isSideChatId(input.requestId) || !isSideChatId(input.threadId)) throw new BoundaryError("invalid side-chat id");
	if (typeof input.text !== "string" || (!input.text.trim() && input.kind !== "prepare" && !(Array.isArray(input.images) && input.images.length)) || input.text.length > SIDE_CHAT_TEXT_LIMIT) throw new BoundaryError("side-chat question is empty or too long");
	if (!Array.isArray(input.history) || input.history.length > SIDE_CHAT_HISTORY_LIMIT) throw new BoundaryError("side-chat history is too long; start a new side chat");
	if (input.model !== undefined && !isSideChatModel(input.model)) throw new BoundaryError("invalid side-chat model");
	const history: SideChatHistoryMessage[] = input.history.map((item: unknown) => {
		if (!item || typeof item !== "object") throw new BoundaryError("invalid side-chat history");
		const message = item as Record<string, unknown>;
		if ((message.role !== "user" && message.role !== "assistant") || typeof message.text !== "string" || message.text.length > SIDE_CHAT_TEXT_LIMIT) throw new BoundaryError("invalid side-chat history");
		return { role: message.role, text: message.text };
	});
	const prompt = parseAgentCommand({ cmd: "prompt", text: input.text, images: input.images });
	if (!prompt.ok) throw new BoundaryError(prompt.error);
	if (input.thinkingLevel !== undefined && (typeof input.thinkingLevel !== "string" || !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(input.thinkingLevel))) throw new BoundaryError("invalid side-chat thinking level");
	if (input.toolPreset !== undefined && !["readonly", "standard", "full"].includes(String(input.toolPreset))) throw new BoundaryError("invalid side-chat tool mode");
	if (input.activeTools !== undefined && (!Array.isArray(input.activeTools) || input.activeTools.length > 1000 || input.activeTools.some((name) => typeof name !== "string" || name.length > 512))) throw new BoundaryError("invalid side-chat tools");
	if (input.leafId !== undefined && (typeof input.leafId !== "string" || input.leafId.length > 128)) throw new BoundaryError("invalid side-chat history leaf");
	const entries = parseSideChatEntries(input.entries);
	return { requestId: input.requestId, threadId: input.threadId, text: input.text.trim(), history,
		...(input.kind === "prepare" ? { kind: "prepare" as const } : {}),
		...(input.retry === true ? { retry: true } : {}),
		...(prompt.command.images?.length ? { images: prompt.command.images } : {}),
		...(entries ? { entries } : {}),
		...(typeof input.leafId === "string" ? { leafId: input.leafId } : {}),
		...(typeof input.thinkingLevel === "string" ? { thinkingLevel: input.thinkingLevel } : {}),
		...(input.toolPreset ? { toolPreset: input.toolPreset as SideChatRequest["toolPreset"] } : {}),
		...(Array.isArray(input.activeTools) ? { activeTools: input.activeTools as string[] } : {}),
		...(isSideChatModel(input.model) ? { model: { provider: input.model.provider.trim(), id: input.model.id.trim() } } : {}),
	};
}

function textContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.flatMap((block) => {
		if (block?.type === "text" && typeof block.text === "string") return [block.text];
		if (block?.type === "image") return ["[Image attachment; image data is not included in this background.]"];
		return [];
	}).join("\n");
}

/** Extract a separate text value, never replay the main session's tool declarations or thinking. */
export function mainConversationText(messages: readonly unknown[]): string {
	return messages.flatMap((value) => {
		if (!value || typeof value !== "object") return [];
		const message = value as Record<string, unknown>;
		if (message.role === "system") return [];
		const text = message.role === "compactionSummary" || message.role === "branchSummary"
			? String(message.summary ?? "")
			: message.role === "bashExecution" && !message.excludeFromContext
				? String(message.output ?? "")
				: textContent(message.content);
		return text.trim() ? [`[${String(message.role)}]\n${text}`] : [];
	}).join("\n\n");
}

export function fitSideChatBackground(text: string, budget: number): string {
	if (bytes(text) <= budget) return text;
	const remainder = Math.max(0, budget - bytes(OMITTED));
	const head = Math.floor(remainder / 5);
	return byteSlice(text, head) + OMITTED + byteSlice(text, remainder - head, true);
}

export function byteSlice(text: string, limit: number, tail = false): string {
	if (limit <= 0) return "";
	const buffer = Buffer.from(text);
	if (buffer.length <= limit) return text;
	if (tail) {
		let start = buffer.length - limit;
		while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start += 1;
		return buffer.subarray(start).toString("utf8");
	}
	let end = limit;
	while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
	return buffer.subarray(0, end).toString("utf8");
}

function historyMessage(item: SideChatHistoryMessage, model: Model<Api>): Message {
	if (item.role === "user") return { role: "user", content: item.text, timestamp: 0 };
	return {
		role: "assistant", content: [{ type: "text", text: item.text }], timestamp: 0,
		api: model.api, provider: model.provider, model: model.id, stopReason: "stop",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	};
}

/** UTF-8 byte budgets are conservative bounds, not reported token measurements. */
export function buildSideChatContext(mainText: string, request: SideChatRequest, model: Model<Api>, options: { tools?: Tool[]; cwd?: string } = {}): { context: Context; contextTruncated: boolean; maxTokens: number; characters: { systemPrompt: number; background: number; systemTools: number } } {
	const maxTokens = Math.min(model.maxTokens, 16_384, Math.max(256, Math.floor(model.contextWindow / 4)));
	const tools = options.tools ?? [];
	const systemPrompt = SIDE_CHAT_SYSTEM_PROMPT + (options.cwd ? `\nWorking directory for the read-only tools: ${JSON.stringify(options.cwd)}. Relative paths resolve from this directory.` : "");
	const toolDeclarations = tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
	const toolText = tools.length ? JSON.stringify(toolDeclarations) : "";
	// Leave room for tool results as well as the quoted conversation and output.
	const toolReserve = tools.length ? Math.min(32_768, Math.floor((model.contextWindow - maxTokens) / 3)) : 0;
	const available = Math.floor(model.contextWindow - maxTokens - 1024 - bytes(systemPrompt) - bytes(toolText) - toolReserve - bytes(MAIN_PREFIX + MAIN_SUFFIX) - bytes(request.text));
	if (available < 256) throw new BoundaryError("question is too long for this model's context window");
	const historyBudget = Math.min(Math.floor(available / 2), Math.max(0, available - Math.min(bytes(mainText), Math.floor(available / 2))));
	let historySize = 0;
	let start = request.history.length;
	while (start > 0) {
		const size = bytes(request.history[start - 1].text) + 64;
		if (historySize + size > historyBudget) break;
		historySize += size;
		start -= 1;
	}
	// Keep complete exchanges: don't begin a truncated transcript with a detached answer.
	while (start < request.history.length && request.history[start].role === "assistant") {
		historySize -= bytes(request.history[start].text) + 64;
		start += 1;
	}
	const mainBudget = Math.max(0, available - historySize);
	const mainTruncated = bytes(mainText) > mainBudget;
	let background = mainText;
	if (mainTruncated) {
		const remainder = Math.max(0, mainBudget - bytes(OMITTED));
		const head = Math.floor(remainder / 5);
		background = byteSlice(mainText, head) + OMITTED + byteSlice(mainText, remainder - head, true);
	}
	return {
		maxTokens,
		// 弹窗里的分项：这两块是旁聊自己的，字面长度就是实际发出去的字符数；
		// 提问与历史回答由前端按消息分类统计（和主界面同一套）
		characters: { systemPrompt: systemPrompt.length, background: background ? (MAIN_PREFIX + background + MAIN_SUFFIX).length : 0, systemTools: toolText.length },
		contextTruncated: mainTruncated || start > 0,
		context: {
			systemPrompt,
			tools: toolDeclarations,
			messages: [
				...(background ? [{ role: "user" as const, content: MAIN_PREFIX + background + MAIN_SUFFIX, timestamp: 0 }] : []),
				...request.history.slice(start).map((item) => historyMessage(item, model)),
				{ role: "user", content: request.text, timestamp: Date.now() },
			],
		},
	};
}
