/**
 * 真正有效的上下文抽取：严格基于 Pi SDK 的 `SessionManager.buildSessionProjection()`
 * 与当前会话注入状态，生成每个分类下实际进入模型上下文窗口的明细条目。
 *
 * 与 UI 聊天分页列表不同：
 * - 压缩（compaction）之前被总结掉的历史不会出现；
 * - 分支切换（branch）只取当前叶子路径；
 * - `context_edit` 修改/删除后的投影已生效；
 * - `!!`（excludeFromContext）的命令不会进入；
 * - `display: false` 的扩展注入消息（hidden）会如实显示；
 * - 未被激活的技能或未注入的文件不会混入。
 */

export type ContextCategoryKey =
	| "system"
	| "builtin"
	| "custom"
	| "memory"
	| "skills"
	| "user"
	| "text"
	| "thinking"
	| "call"
	| "output"
	| "compacted";

export const CONTEXT_CATEGORY_KEYS: readonly ContextCategoryKey[] = [
	"system",
	"builtin",
	"custom",
	"memory",
	"skills",
	"user",
	"text",
	"thinking",
	"call",
	"output",
	"compacted",
];

export type ContextItemTag =
	| "builtin"
	| "extension"
	| "piweb"
	| "shell"
	| "hidden"
	| "compaction"
	| "branch"
	| "aborted"
	| "error";

export interface ContextInspectItem {
	id: string;
	category: ContextCategoryKey;
	title: string;
	subtitle?: string;
	tag?: ContextItemTag;
	tagText?: string;
	isError?: boolean;
	/** 截断前的完整字符数 */
	chars: number;
	content: string;
	truncated?: boolean;
	timestamp?: number;
	turn?: number;
}

export interface EffectiveContextResponse {
	cold: boolean;
	categories: Record<ContextCategoryKey, ContextInspectItem[]>;
	totals: Record<ContextCategoryKey, number>;
}

export const MAX_INSPECT_ITEM_CHARS = 512 * 1024;

const SKILLS_SECTION_START = "The following skills provide specialized instructions";
const SKILLS_SECTION_END = "</available_skills>";
const BUILTIN_TOOL_NAMES = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);

export interface EffectiveModelRef {
	provider?: string;
	api?: string;
	id?: string;
}

export interface ContextMessageLike {
	id?: string;
	role?: string;
	customType?: string;
	content: Array<{
		type: string;
		text?: string;
		thinking?: string;
		id?: string;
		name?: string;
		arguments?: unknown;
		toolCallId?: string;
		isError?: boolean;
		title?: string;
		url?: string;
		mimeType?: string;
	}>;
	bash?: { command: string; output: string; excludeFromContext?: boolean };
	usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
	stopReason?: string;
	timestamp?: number;
	summaryKind?: string;
	summary?: string;
	model?: string;
	provider?: string;
	api?: string;
	thinkingLevel?: string;
	firstKeptEntryId?: string;
}

export interface BuildEffectiveContextInput {
	/** 来自 SessionManager.buildSessionProjection().messages 的权威上下文投影 */
	projectedMessages: Array<Record<string, unknown>>;
	/** 热会话实例（如已启动） */
	session?: {
		systemPrompt?: string;
		getActiveToolNames?: () => string[];
		getAllTools?: () => Array<{
			name: string;
			description?: string;
			parameters?: unknown;
			promptGuidelines?: string[];
			sourceInfo?: { source?: string };
		}>;
	} | null;
	/** 当前生效的模型：用于与 pi-ai transformMessages 对齐，剔除切模型后失效的 thinking 块 */
	currentModel?: EffectiveModelRef | null;
	/** 尚未持久化 system 消息时用于展示待注入的项目记忆文件（source === "project"） */
	projectMemoryResources?: Array<{ path: string; content: string }>;
	/** 冷会话尚未持久化 system 消息时用于展示待注入的 <available_skills> 片段 */
	coldSkillsText?: string;
}

function isSameEffectiveModel(message: Record<string, unknown>, currentModel?: EffectiveModelRef | null): boolean {
	if (!currentModel?.id) return true;
	const msgModel = typeof message.model === "string" ? message.model : undefined;
	if (!msgModel) return true;
	const msgProvider = typeof message.provider === "string" ? message.provider : undefined;
	const msgApi = typeof message.api === "string" ? message.api : undefined;
	return (
		msgModel === currentModel.id
		&& (!currentModel.provider || !msgProvider || msgProvider === currentModel.provider)
		&& (!currentModel.api || !msgApi || msgApi === currentModel.api)
	);
}

/** 压缩状态行按完成时间显示，上下文从 SDK 保留的第一条消息算起。 */
export function inContextMessages<T extends { id?: string; role?: string; summaryKind?: string; firstKeptEntryId?: string; timestamp?: number }>(
	messages: T[],
): { messages: T[]; since?: number } {
	const at = messages.findLastIndex((m) => m.role === "summary" && m.summaryKind === "compaction");
	if (at < 0) return { messages };
	const { firstKeptEntryId, timestamp } = messages[at];
	// 向上翻页之前，第一条保留消息可能早于当前加载窗口。
	const from = firstKeptEntryId ? Math.max(0, messages.findIndex((message) => message.id === firstKeptEntryId)) : at + 1;
	return { messages: messages.slice(from), since: timestamp };
}

function firstLine(text: string, maxLen = 96): string | undefined {
	const line = text.replace(/\s+/g, " ").trim();
	if (!line) return undefined;
	return line.length > maxLen ? `${line.slice(0, maxLen - 1)}…` : line;
}

function pathBasename(filePath: string): string {
	const parts = filePath.replace(/\\/g, "/").split("/").filter(Boolean);
	return parts.at(-1) ?? filePath;
}

/** 提取工具调用参数的简短预览（用于调用与输出条目的副标题） */
export function summarizeToolArgs(args: unknown): string | undefined {
	if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
	const record = args as Record<string, unknown>;
	for (const key of ["path", "file_path", "command", "pattern", "query", "url"]) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) {
			return firstLine(value, 80);
		}
	}
	return undefined;
}

/** 格式化工具定义文本 */
export function formatToolSchema(tool: {
	name: string;
	description?: string;
	parameters?: unknown;
	promptGuidelines?: string[];
}): string {
	const blocks: string[] = [`# ${tool.name}`];
	if (tool.description?.trim()) blocks.push(tool.description.trim());
	if (tool.promptGuidelines?.length) {
		blocks.push(tool.promptGuidelines.map((line) => `- ${line}`).join("\n"));
	}
	if (tool.parameters !== undefined) {
		blocks.push(JSON.stringify(tool.parameters, null, 2));
	}
	return blocks.join("\n\n");
}

/** 从字符串或内容块数组中抽取纯文本 */
export function extractTextContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const block = part as { type?: unknown; text?: unknown };
		if ((block.type === "text" || block.type === "toolResult") && typeof block.text === "string") {
			parts.push(block.text);
		}
	}
	return parts.join("\n");
}

function createEmptyCategories(): Record<ContextCategoryKey, ContextInspectItem[]> {
	return {
		system: [],
		builtin: [],
		custom: [],
		memory: [],
		skills: [],
		user: [],
		text: [],
		thinking: [],
		call: [],
		output: [],
		compacted: [],
	};
}

function makeItem(
	raw: Omit<ContextInspectItem, "chars" | "truncated"> & { chars?: number },
): ContextInspectItem {
	const chars = raw.chars ?? raw.content.length;
	if (raw.content.length > MAX_INSPECT_ITEM_CHARS) {
		return {
			...raw,
			chars,
			content: raw.content.slice(0, MAX_INSPECT_ITEM_CHARS),
			truncated: true,
		};
	}
	return { ...raw, chars };
}

function computeTotals(categories: Record<ContextCategoryKey, ContextInspectItem[]>): Record<ContextCategoryKey, number> {
	const totals = {} as Record<ContextCategoryKey, number>;
	for (const key of CONTEXT_CATEGORY_KEYS) {
		totals[key] = categories[key].reduce((sum, item) => sum + item.chars, 0);
	}
	return totals;
}

/**
 * 基于 Pi SDK 投影消息与当前会话状态构造「真正进入模型窗口的有效上下文」。
 * 系统/工具/记忆/技能三分支与 agent-manager 的 buildContextBreakdown 保持同源口径。
 */
export function buildEffectiveContext(input: BuildEffectiveContextInput): EffectiveContextResponse {
	const categories = createEmptyCategories();
	const messages = input.projectedMessages ?? [];
	const session = input.session ?? null;

	let systemMessage: Record<string, unknown> | undefined;
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		if (messages[i]?.role === "system") {
			systemMessage = messages[i];
			break;
		}
	}

	let cold = !session && !systemMessage;

	if (systemMessage) {
		cold = false;
		const mainText = extractTextContent(systemMessage.content);
		if (mainText.length > 0) {
			categories.system.push(makeItem({
				id: "system:main",
				category: "system",
				title: "System Prompt",
				subtitle: firstLine(mainText),
				content: mainText,
			}));
		}
		const sections = (systemMessage.sections && typeof systemMessage.sections === "object"
			? systemMessage.sections
			: {}) as Record<string, unknown>;
		for (const [sectionKey, sectionValue] of Object.entries(sections)) {
			if (sectionKey === "project_context" || sectionKey === "skills") continue;
			if (typeof sectionValue === "string" && sectionValue.length > 0) {
				categories.system.push(makeItem({
					id: `system:section:${sectionKey}`,
					category: "system",
					title: sectionKey,
					subtitle: firstLine(sectionValue),
					content: sectionValue,
				}));
			}
		}
		if (typeof sections.project_context === "string" && sections.project_context.length > 0) {
			categories.memory.push(makeItem({
				id: "memory:injected",
				category: "memory",
				title: "AGENTS.md (Project Context)",
				subtitle: firstLine(sections.project_context),
				content: sections.project_context,
			}));
		}
		if (typeof sections.skills === "string" && sections.skills.length > 0) {
			categories.skills.push(makeItem({
				id: "skills:injected",
				category: "skills",
				title: "Skills (<available_skills>)",
				subtitle: firstLine(sections.skills),
				content: sections.skills,
			}));
		}

		const builtinNames = new Set(
			session?.getAllTools
				? session.getAllTools().filter((t) => t.sourceInfo?.source === "builtin").map((t) => t.name)
				: [...BUILTIN_TOOL_NAMES],
		);
		const toolsAdded = Array.isArray(systemMessage.toolsAdded) ? systemMessage.toolsAdded : [];
		for (let i = 0; i < toolsAdded.length; i += 1) {
			const tool = toolsAdded[i] as { name?: string; description?: string; parameters?: unknown; promptGuidelines?: string[] };
			if (!tool?.name) continue;
			const isBuiltin = builtinNames.has(tool.name);
			const category: ContextCategoryKey = isBuiltin ? "builtin" : "custom";
			const rawChars = JSON.stringify(tool).length;
			categories[category].push(makeItem({
				id: `${category}:${tool.name}:${i}`,
				category,
				title: tool.name,
				subtitle: tool.description ? firstLine(tool.description) : undefined,
				tag: isBuiltin ? "builtin" : "extension",
				chars: rawChars,
				content: formatToolSchema({ name: tool.name, description: tool.description, parameters: tool.parameters, promptGuidelines: tool.promptGuidelines }),
			}));
		}
		categories.builtin.sort((a, b) => b.chars - a.chars);
		categories.custom.sort((a, b) => b.chars - a.chars);
	} else if (session) {
		cold = false;
		const prompt = session.systemPrompt ?? "";
		const start = prompt.indexOf(SKILLS_SECTION_START);
		const end = prompt.indexOf(SKILLS_SECTION_END);
		const skillsSlice = start >= 0 && end > start ? prompt.slice(start, end + SKILLS_SECTION_END.length) : "";
		if (skillsSlice.length > 0) {
			categories.skills.push(makeItem({
				id: "skills:injected",
				category: "skills",
				title: "Skills (<available_skills>)",
				subtitle: firstLine(skillsSlice),
				content: skillsSlice,
			}));
		}

		for (const resource of input.projectMemoryResources ?? []) {
			if (!resource.content) continue;
			categories.memory.push(makeItem({
				id: `memory:${resource.path}`,
				category: "memory",
				title: pathBasename(resource.path),
				subtitle: resource.path,
				content: resource.content,
			}));
		}
		categories.memory.sort((a, b) => b.chars - a.chars);

		let core = skillsSlice ? prompt.replace(skillsSlice, "") : prompt;
		for (const resource of input.projectMemoryResources ?? []) {
			if (resource.content && core.includes(resource.content)) {
				core = core.replace(resource.content, "");
			}
		}
		core = core.replace(/\n{3,}/g, "\n\n").trim();
		if (core.length > 0) {
			categories.system.push(makeItem({
				id: "system:main",
				category: "system",
				title: "System Prompt",
				subtitle: firstLine(core),
				content: core,
			}));
		}

		const activeNames = new Set(session.getActiveToolNames?.() ?? []);
		const allTools = session.getAllTools?.() ?? [];
		const activeTools = activeNames.size > 0 ? allTools.filter((tool) => activeNames.has(tool.name)) : allTools;
		for (let i = 0; i < activeTools.length; i += 1) {
			const tool = activeTools[i];
			const isBuiltin = tool.sourceInfo?.source === "builtin" || (!tool.sourceInfo?.source && BUILTIN_TOOL_NAMES.has(tool.name));
			const category: ContextCategoryKey = isBuiltin ? "builtin" : "custom";
			const rawChars = JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }).length;
			categories[category].push(makeItem({
				id: `${category}:${tool.name}:${i}`,
				category,
				title: tool.name,
				subtitle: tool.description ? firstLine(tool.description) : undefined,
				tag: isBuiltin ? "builtin" : "extension",
				chars: rawChars,
				content: formatToolSchema(tool),
			}));
		}
		categories.builtin.sort((a, b) => b.chars - a.chars);
		categories.custom.sort((a, b) => b.chars - a.chars);
	} else {
		for (const resource of input.projectMemoryResources ?? []) {
			if (!resource.content) continue;
			categories.memory.push(makeItem({
				id: `memory:${resource.path}`,
				category: "memory",
				title: pathBasename(resource.path),
				subtitle: resource.path,
				content: resource.content,
			}));
		}
		categories.memory.sort((a, b) => b.chars - a.chars);
		if (input.coldSkillsText?.trim()) {
			const skillsText = input.coldSkillsText.trim();
			categories.skills.push(makeItem({
				id: "skills:injected",
				category: "skills",
				title: "Skills (<available_skills>)",
				subtitle: firstLine(skillsText),
				content: skillsText,
			}));
		}
	}

	const toolCallMap = new Map<string, { name: string; argSummary?: string }>();
	for (const message of messages) {
		if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
		if (message.stopReason === "error" || message.stopReason === "aborted") continue;
		for (const part of message.content) {
			if (part && typeof part === "object" && (part as { type?: string }).type === "toolCall") {
				const call = part as { id?: string; name?: string; arguments?: unknown };
				if (call.id && call.name) {
					toolCallMap.set(call.id, { name: call.name, argSummary: summarizeToolArgs(call.arguments) });
				}
			}
		}
	}

	let turn = 0;
	for (let i = 0; i < messages.length; i += 1) {
		const message = messages[i];
		if (!message || typeof message !== "object") continue;
		const role = typeof message.role === "string" ? message.role : "";
		const timestamp = typeof message.timestamp === "number" ? message.timestamp : undefined;

		if (role === "system") continue;

		if (role === "compactionSummary" || role === "branchSummary") {
			const summary = typeof message.summary === "string" ? message.summary : "";
			if (summary.length > 0) {
				categories.compacted.push(makeItem({
					id: `compacted:${i}`,
					category: "compacted",
					title: role === "compactionSummary" ? "Compaction summary" : "Branch summary",
					subtitle: firstLine(summary),
					tag: role === "compactionSummary" ? "compaction" : "branch",
					content: summary,
					timestamp,
				}));
			}
			continue;
		}

		if (role === "bashExecution") {
			if (message.excludeFromContext === true) continue;
			const command = typeof message.command === "string" ? message.command : "";
			const output = typeof message.output === "string" ? message.output : "";
			const content = output ? `$ ${command}\n${output}` : `$ ${command}`;
			categories.user.push(makeItem({
				id: `user:bash:${i}`,
				category: "user",
				title: `! ${firstLine(command, 64) ?? "shell"}`,
				subtitle: output ? firstLine(output) : undefined,
				tag: "shell",
				chars: command.length + output.length,
				content,
				timestamp,
				...(turn > 0 ? { turn } : {}),
			}));
			continue;
		}

		if (role === "user") {
			turn += 1;
			const text = extractTextContent(message.content);
			if (text.length > 0) {
				categories.user.push(makeItem({
					id: `user:${i}`,
					category: "user",
					title: "",
					subtitle: firstLine(text),
					content: text,
					timestamp,
					turn,
				}));
			}
			continue;
		}

		if (role === "custom") {
			const text = extractTextContent(message.content);
			if (text.length > 0) {
				const customType = typeof message.customType === "string" && message.customType ? message.customType : "custom";
				categories.user.push(makeItem({
					id: `user:custom:${i}`,
					category: "user",
					title: customType,
					subtitle: firstLine(text),
					tag: message.display === false ? "hidden" : "extension",
					content: text,
					timestamp,
					...(turn > 0 ? { turn } : {}),
				}));
			}
			continue;
		}

		if (role === "assistant") {
			if (message.stopReason === "error" || message.stopReason === "aborted") continue;
			const sameModel = isSameEffectiveModel(message, input.currentModel);
			const parts = Array.isArray(message.content) ? message.content : [];
			const textParts: string[] = [];
			let textChars = 0;
			for (let j = 0; j < parts.length; j += 1) {
				const part = parts[j] as { type?: string; text?: string; thinking?: string; name?: string; arguments?: unknown } | null;
				if (!part || typeof part !== "object") continue;
				if (part.type === "text" && typeof part.text === "string" && part.text.length > 0) {
					textParts.push(part.text);
					textChars += part.text.length;
				} else if (part.type === "thinking" && sameModel && typeof part.thinking === "string" && part.thinking.trim().length > 0) {
					categories.thinking.push(makeItem({
						id: `thinking:${i}:${j}`,
						category: "thinking",
						title: "",
						subtitle: firstLine(part.thinking),
						...(typeof message.thinkingLevel === "string" && message.thinkingLevel ? { tagText: message.thinkingLevel } : {}),
						content: part.thinking,
						timestamp,
						...(turn > 0 ? { turn } : {}),
					}));
				} else if (part.type === "toolCall") {
					const name = typeof part.name === "string" && part.name ? part.name : "tool";
					const serializedArgs = JSON.stringify(part.arguments ?? "");
					const prettyArgs = JSON.stringify(part.arguments ?? {}, null, 2);
					categories.call.push(makeItem({
						id: `call:${i}:${j}`,
						category: "call",
						title: name,
						subtitle: summarizeToolArgs(part.arguments),
						chars: name.length + serializedArgs.length,
						content: prettyArgs,
						timestamp,
						...(turn > 0 ? { turn } : {}),
					}));
				}
			}
			if (textChars > 0) {
				const joined = textParts.join("\n");
				categories.text.push(makeItem({
					id: `text:${i}`,
					category: "text",
					title: "",
					subtitle: firstLine(joined),
					chars: textChars,
					content: joined,
					timestamp,
					...(turn > 0 ? { turn } : {}),
				}));
			}
			continue;
		}

		if (role === "toolResult") {
			const text = extractTextContent(message.content);
			const isError = message.isError === true;
			if (text.length === 0 && !isError) continue;
			const callId = typeof message.toolCallId === "string" ? message.toolCallId : undefined;
			const matched = callId ? toolCallMap.get(callId) : undefined;
			const fallbackName = typeof message.toolName === "string" ? message.toolName : "";
			categories.output.push(makeItem({
				id: `output:${i}`,
				category: "output",
				title: matched?.name || fallbackName || "Tool Output",
				subtitle: matched?.argSummary,
				isError,
				...(isError ? { tag: "error" as const } : {}),
				chars: text.length,
				content: text,
				timestamp,
				...(turn > 0 ? { turn } : {}),
			}));
		}
	}

	return {
		cold,
		categories,
		totals: computeTotals(categories),
	};
}

/**
 * 无 sessionId 时的客户端回退抽取（如单测或离线静态预览）：
 * 复用与 ContextMeter 一致的压缩截断规则从前端消息中提取消息类有效条目。
 */
export function extractClientEffectiveContext(
	messages: ContextMessageLike[],
	currentModel?: EffectiveModelRef | null,
): EffectiveContextResponse {
	const categories = createEmptyCategories();
	const { messages: active } = inContextMessages(messages);

	const toolCallMap = new Map<string, { name: string; argSummary?: string }>();
	for (const message of active) {
		if (message.role === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted")) continue;
		for (const part of message.content ?? []) {
			if (part.type === "toolCall" && part.id && part.name) {
				toolCallMap.set(part.id, { name: part.name, argSummary: summarizeToolArgs(part.arguments) });
			}
		}
	}

	// 若消息列里有最新一次压缩摘要文本，也作为 compacted 条目展示
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const m = messages[i];
		if (m.role === "summary" && m.summaryKind === "compaction") {
			if (typeof m.summary === "string" && m.summary.length > 0) {
				categories.compacted.push(makeItem({
					id: `compacted:summary:${i}`,
					category: "compacted",
					title: "Compaction summary",
					subtitle: firstLine(m.summary),
					tag: "compaction",
					content: m.summary,
					timestamp: m.timestamp,
				}));
			}
			break;
		}
	}

	let turn = 0;
	for (let i = 0; i < active.length; i += 1) {
		const message = active[i];
		if (message.role === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted")) {
			continue;
		}
		const sameModel = message.role !== "assistant" || isSameEffectiveModel(message as unknown as Record<string, unknown>, currentModel);
		if (message.role === "bashExecution") {
			if (message.bash && !message.bash.excludeFromContext) {
				const content = message.bash.output ? `$ ${message.bash.command}\n${message.bash.output}` : `$ ${message.bash.command}`;
				categories.user.push(makeItem({
					id: `user:bash:${i}`,
					category: "user",
					title: `! ${firstLine(message.bash.command, 64) ?? "shell"}`,
					subtitle: message.bash.output ? firstLine(message.bash.output) : undefined,
					tag: "shell",
					chars: message.bash.command.length + message.bash.output.length,
					content,
					timestamp: message.timestamp,
					...(turn > 0 ? { turn } : {}),
				}));
			}
			continue;
		}

		if (message.role === "user") turn += 1;
		const textParts: string[] = [];
		let textChars = 0;

		for (let j = 0; j < (message.content?.length ?? 0); j += 1) {
			const part = message.content[j];
			if (part.type === "text" && typeof part.text === "string" && part.text.length > 0) {
				if (message.role === "toolResult") {
					categories.output.push(makeItem({
						id: `output:text:${i}:${j}`,
						category: "output",
						title: "Tool Output",
						content: part.text,
						timestamp: message.timestamp,
						...(turn > 0 ? { turn } : {}),
					}));
				} else if (message.role !== "system") {
					textParts.push(part.text);
					textChars += part.text.length;
				}
			} else if (part.type === "thinking" && sameModel && typeof part.thinking === "string" && part.thinking.trim().length > 0) {
				categories.thinking.push(makeItem({
					id: `thinking:${i}:${j}`,
					category: "thinking",
					title: "",
					subtitle: firstLine(part.thinking),
					...(message.thinkingLevel ? { tagText: message.thinkingLevel } : {}),
					content: part.thinking,
					timestamp: message.timestamp,
					...(turn > 0 ? { turn } : {}),
				}));
			} else if (part.type === "toolCall") {
				const name = part.name || "tool";
				categories.call.push(makeItem({
					id: `call:${i}:${j}`,
					category: "call",
					title: name,
					subtitle: summarizeToolArgs(part.arguments),
					chars: name.length + JSON.stringify(part.arguments ?? "").length,
					content: JSON.stringify(part.arguments ?? {}, null, 2),
					timestamp: message.timestamp,
					...(turn > 0 ? { turn } : {}),
				}));
			} else if (part.type === "toolResult") {
				const text = part.text ?? "";
				const isError = part.isError === true;
				if (text.length === 0 && !isError) continue;
				const matched = part.toolCallId ? toolCallMap.get(part.toolCallId) : undefined;
				categories.output.push(makeItem({
					id: `output:${i}:${j}`,
					category: "output",
					title: matched?.name || part.title || "Tool Output",
					subtitle: matched?.argSummary,
					isError,
					...(isError ? { tag: "error" as const } : {}),
					content: text,
					timestamp: message.timestamp,
					...(turn > 0 ? { turn } : {}),
				}));
			}
		}

		if (textChars > 0) {
			const joined = textParts.join("\n");
			if (message.role === "user" || message.role === "custom") {
				categories.user.push(makeItem({
					id: `user:${i}`,
					category: "user",
					title: message.role === "custom" ? (message.customType || "custom") : "",
					subtitle: firstLine(joined),
					...(message.role === "custom" ? { tag: "extension" as const } : {}),
					chars: textChars,
					content: joined,
					timestamp: message.timestamp,
					...(turn > 0 ? { turn } : {}),
				}));
			} else if (message.role !== "toolResult" && message.role !== "system" && message.role !== "summary" && message.role !== "modelChange") {
				categories.text.push(makeItem({
					id: `text:${i}`,
					category: "text",
					title: "",
					subtitle: firstLine(joined),
					chars: textChars,
					content: joined,
					timestamp: message.timestamp,
					...(turn > 0 ? { turn } : {}),
				}));
			}
		}
	}

	return {
		cold: false,
		categories,
		totals: computeTotals(categories),
	};
}
