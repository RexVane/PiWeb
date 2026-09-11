import { describe, expect, it } from "vitest";
import { parseAgentCommand } from "../src/lib/command-validation";

describe("agent command validation", () => {
	it("accepts the read-only trajectory preparation command", () => {
		const result = parseAgentCommand({ cmd: "prepare" });
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.command.cmd).toBe("prepare");
	});

	it("accepts image prompts and an explicit streaming behavior", () => {
		const result = parseAgentCommand({
			cmd: "prompt",
			text: "inspect this",
			behavior: "followUp",
			images: [{ type: "image", mimeType: "image/png", data: "aGVsbG8=" }],
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.command.behavior).toBe("followUp");
			expect(result.command.images).toHaveLength(1);
		}
	});

	it("rejects unknown tool presets instead of escalating to all tools", () => {
		const result = parseAgentCommand({ cmd: "setToolPreset", preset: "typo" });
		expect(result).toEqual({ ok: false, error: "invalid tool preset" });
	});

	it("rejects malformed and unsupported images", () => {
		expect(
			parseAgentCommand({ cmd: "prompt", images: [{ type: "image", mimeType: "image/svg+xml", data: "PHN2Zz4=" }] }).ok,
		).toBe(false);
		expect(
			parseAgentCommand({ cmd: "prompt", images: [{ type: "image", mimeType: "image/png", data: "not base64!" }] }).ok,
		).toBe(false);
	});

	it("requires model and navigation identifiers", () => {
		expect(parseAgentCommand({ cmd: "setModel", provider: "openai" }).ok).toBe(false);
		expect(parseAgentCommand({ cmd: "navigate" }).ok).toBe(false);
	});

	// ---------- 附件限额（对齐 dsh attachment-local DEFAULT_*） ----------

	const image = (data: string) => ({ type: "image", mimeType: "image/png", data });

	it("accepts exactly 20 images per message (dsh maxImagesPerMessage)", () => {
		const result = parseAgentCommand({ cmd: "prompt", text: "x", images: Array.from({ length: 20 }, () => image("aGVsbG8=")) });
		expect(result.ok).toBe(true);
	});

	it("rejects 21 images", () => {
		const result = parseAgentCommand({ cmd: "prompt", text: "x", images: Array.from({ length: 21 }, () => image("aGVsbG8=")) });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("at most 20");
	});

	it("rejects a single image over 20MB (28MB base64, dsh maxImageBytes)", () => {
		const over = parseAgentCommand({ cmd: "prompt", images: [image("A".repeat(28_000_001))] });
		expect(over.ok).toBe(false);
		const edge = parseAgentCommand({ cmd: "prompt", images: [image("A".repeat(28_000_000))] });
		expect(edge.ok).toBe(true);
	});

	it("rejects images totaling over 200MB (268MB base64, dsh maxMessageImageBytes)", () => {
		// 20 张 × 13.4MB base64 = 268,000,000 恰好在界内（> 才拒绝）
		const atCap = parseAgentCommand({ cmd: "prompt", images: Array.from({ length: 20 }, () => image("A".repeat(13_400_000))) });
		expect(atCap.ok).toBe(true);
		// 19 张 13.4MB + 1 张 13,400,001 → 总量 268,000,001 越界
		const over = parseAgentCommand({
			cmd: "prompt",
			images: [
				...Array.from({ length: 19 }, () => image("A".repeat(13_400_000))),
				image("A".repeat(13_400_001)),
			],
		});
		expect(over.ok).toBe(false);
		if (!over.ok) expect(over.error).toContain("too large");
	});

	it("validates setActiveTools names payload", () => {
		expect(parseAgentCommand({ cmd: "setActiveTools", names: ["read", "bash"] }).ok).toBe(true);
		expect(parseAgentCommand({ cmd: "setActiveTools" }).ok).toBe(false);
		expect(parseAgentCommand({ cmd: "setActiveTools", names: [] }).ok).toBe(false);
		expect(parseAgentCommand({ cmd: "setActiveTools", names: ["ok", 42] }).ok).toBe(false);
	});
});
