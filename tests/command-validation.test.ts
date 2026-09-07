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
});
