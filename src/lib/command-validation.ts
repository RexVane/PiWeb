import type { AgentCommand, ImageAttachment, ToolPreset } from "./types";

const COMMANDS = new Set<AgentCommand["cmd"]>([
	"prepare",
	"prompt",
	"steer",
	"followUp",
	"abort",
	"compact",
	"setModel",
	"setThinkingLevel",
	"setToolPreset",
	"setActiveTools",
	"rename",
	"fork",
	"cycleModel",
	"navigate",
	"clearQueue",
	"extensionUiResponse",
	"reload",
]);
const TOOL_PRESETS = new Set<ToolPreset>(["readonly", "standard", "full"]);
const STREAMING_BEHAVIORS = new Set(["steer", "followUp"]);
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const MAX_TEXT = 1_000_000;
const MAX_IMAGES = 20;
const MAX_IMAGE_BASE64 = 28_000_000; // dsh: 单图 20MB
const MAX_IMAGES_BASE64 = 268_000_000; // dsh: 单条消息图片总量 200MB

export type CommandParseResult = { ok: true; command: AgentCommand } | { ok: false; error: string };

function optionalText(value: unknown, field: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw new Error(`${field} must be a string`);
	if (value.length > MAX_TEXT) throw new Error(`${field} is too long`);
	return value;
}

function parseImages(value: unknown): ImageAttachment[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.length > MAX_IMAGES) throw new Error(`images must contain at most ${MAX_IMAGES} items`);
	let total = 0;
	return value.map((raw) => {
		if (!raw || typeof raw !== "object") throw new Error("invalid image");
		const image = raw as Record<string, unknown>;
		if (image.type !== "image" || typeof image.data !== "string" || typeof image.mimeType !== "string") {
			throw new Error("invalid image");
		}
		if (!IMAGE_TYPES.has(image.mimeType)) throw new Error(`unsupported image type ${image.mimeType}`);
		if (image.data.length === 0 || image.data.length > MAX_IMAGE_BASE64 || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)) {
			throw new Error("invalid or oversized image data");
		}
		total += image.data.length;
		if (total > MAX_IMAGES_BASE64) throw new Error("image attachments are too large");
		return { type: "image", data: image.data, mimeType: image.mimeType };
	});
}

export function parseAgentCommand(value: unknown): CommandParseResult {
	try {
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("command must be an object");
		const raw = value as Record<string, unknown>;
		if (typeof raw.cmd !== "string" || !COMMANDS.has(raw.cmd as AgentCommand["cmd"])) throw new Error("unknown command");

		const command: AgentCommand = {
			cmd: raw.cmd as AgentCommand["cmd"],
			text: optionalText(raw.text, "text"),
			instructions: optionalText(raw.instructions, "instructions"),
			provider: optionalText(raw.provider, "provider"),
			modelId: optionalText(raw.modelId, "modelId"),
			level: optionalText(raw.level, "level"),
			entryId: optionalText(raw.entryId, "entryId"),
			images: parseImages(raw.images),
		};

		if (raw.preset !== undefined) {
			if (typeof raw.preset !== "string" || !TOOL_PRESETS.has(raw.preset as ToolPreset)) throw new Error("invalid tool preset");
			command.preset = raw.preset as ToolPreset;
		}
		if (raw.behavior !== undefined) {
			if (typeof raw.behavior !== "string" || !STREAMING_BEHAVIORS.has(raw.behavior)) throw new Error("invalid streaming behavior");
			command.behavior = raw.behavior as "steer" | "followUp";
		}
		if (raw.direction !== undefined) {
			if (raw.direction !== "forward" && raw.direction !== "backward") throw new Error("invalid cycle direction");
			command.direction = raw.direction;
		}
		if (raw.names !== undefined) {
			// setActiveTools 的目标工具名列表：数量与长度上限防滥用（未知名字由 agent-manager 求交集丢弃）
			if (!Array.isArray(raw.names) || raw.names.length === 0 || raw.names.length > 64 || raw.names.some((n) => typeof n !== "string" || !n || n.length > 100)) {
				throw new Error("names must be a non-empty array of tool names");
			}
			command.names = raw.names as string[];
		}

		if (raw.requestId !== undefined) command.requestId = optionalText(raw.requestId, "requestId");
		if (raw.value !== undefined) command.value = optionalText(raw.value, "value");
		if (raw.confirmed !== undefined) {
			if (typeof raw.confirmed !== "boolean") throw new Error("confirmed must be a boolean");
			command.confirmed = raw.confirmed;
		}
		if (raw.cancelled !== undefined) {
			if (typeof raw.cancelled !== "boolean") throw new Error("cancelled must be a boolean");
			command.cancelled = raw.cancelled;
		}
		if (command.cmd === "extensionUiResponse" && !command.requestId) throw new Error("requestId is required");
		if (command.cmd === "setModel" && (!command.provider || !command.modelId)) throw new Error("provider and modelId are required");
		if (command.cmd === "setThinkingLevel" && !command.level) throw new Error("level is required");
		if (command.cmd === "setToolPreset" && !command.preset) throw new Error("preset is required");
		if (command.cmd === "setActiveTools" && !command.names) throw new Error("names are required");
		if (command.cmd === "navigate" && !command.entryId) throw new Error("entryId is required");
		return { ok: true, command };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : "invalid command" };
	}
}
