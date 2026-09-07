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
	"rename",
	"fork",
	"cycleModel",
	"navigate",
	"clearQueue",
]);
const TOOL_PRESETS = new Set<ToolPreset>(["readonly", "standard", "full"]);
const STREAMING_BEHAVIORS = new Set(["steer", "followUp"]);
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const MAX_TEXT = 1_000_000;
const MAX_IMAGES = 8;
const MAX_IMAGE_BASE64 = 14_000_000;
const MAX_IMAGES_BASE64 = 42_000_000;

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

		if (command.cmd === "setModel" && (!command.provider || !command.modelId)) throw new Error("provider and modelId are required");
		if (command.cmd === "setThinkingLevel" && !command.level) throw new Error("level is required");
		if (command.cmd === "setToolPreset" && !command.preset) throw new Error("preset is required");
		if (command.cmd === "navigate" && !command.entryId) throw new Error("entryId is required");
		return { ok: true, command };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : "invalid command" };
	}
}
