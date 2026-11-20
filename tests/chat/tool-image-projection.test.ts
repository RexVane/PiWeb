import { describe, expect, it } from "vitest";
import { getSessionHistory, readSessionImage, toWebMessage, type Managed } from "@/lib/agent-manager";
import { previewMessage } from "@/lib/chat/web-history";

const first = { type: "image" as const, data: "Zmlyc3Q=", mimeType: "image/png" };
const second = { type: "image" as const, data: "c2Vjb25k", mimeType: "image/jpeg" };
const result = { role: "toolResult", toolCallId: "read-1", toolName: "read", content: [{ type: "text", text: "Read image file [image/png]" }, first, second], isError: false, timestamp: 1000 };

describe("tool image message projection", () => {
	it("retains images alongside the tool-result marker without changing its text or metadata", () => {
		const message = toWebMessage(result, "entry-result");
		expect(message).toMatchObject({ id: "entry-result", role: "toolResult", timestamp: 1000 });
		expect(message.content).toEqual([
			expect.objectContaining({ type: "toolResult", toolCallId: "read-1", text: "Read image file [image/png]", isError: false }),
			first, second,
		]);
		expect(result.content).toHaveLength(3);
	});

	it("keeps an image-only result and leaves ordinary text results unchanged", () => {
		expect(toWebMessage({ ...result, content: [first] }).content).toEqual([
			expect.objectContaining({ type: "toolResult", toolCallId: "read-1", text: "" }), first,
		]);
		expect(toWebMessage({ ...result, content: [{ type: "text", text: "plain text" }], isError: true }).content).toEqual([
			expect.objectContaining({ type: "toolResult", text: "plain text", isError: true }),
		]);
	});

	it("uses authenticated lazy URLs in history and serves the matching persisted image parts", () => {
		const entries = [{ type: "message", id: "entry-result", message: result }];
		const managed = { sessionPath: "/private/session.jsonl", sm: { getBranch: () => entries, buildContextEntries: () => entries, getEntries: () => entries } } as unknown as Managed;
		const page = getSessionHistory(managed);
		const images = page.messages[0].content.filter((part) => part.type === "image");
		expect(images).toHaveLength(2);
		expect(images.map((image) => image.data)).toEqual(["", ""]);
		expect(images[0].url).toMatch(/^\/api\/sessions\/[^/]+\/images\?entry=entry-result&part=1$/);
		expect(images[1].url).toContain("&part=2");
		expect(readSessionImage(managed, "entry-result", 1)).toEqual({ data: Buffer.from(first.data, "base64"), mimeType: "image/png" });
		expect(readSessionImage(managed, "entry-result", 2)).toEqual({ data: Buffer.from(second.data, "base64"), mimeType: "image/jpeg" });
		expect(() => readSessionImage(managed, "entry-result", 0)).toThrow("Image not found");
		expect(() => readSessionImage(managed, "missing", 1)).toThrow("Image not found");
	});

	it("does not embed large persisted image bodies in previews or mutate their source", () => {
		const large = { ...first, data: "A".repeat(8_000_000) };
		const original = toWebMessage({ ...result, content: [large] }, "entry-large");
		const preview = previewMessage(original, (part) => `/api/sessions/s/images?entry=entry-large&part=${part}`);
		expect(preview.content[1]).toEqual({ ...large, data: "", url: "/api/sessions/s/images?entry=entry-large&part=1" });
		expect(JSON.stringify(preview).length).toBeLessThan(1000);
		expect(original.content[1]).toHaveProperty("data", large.data);
	});
});
