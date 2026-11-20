import { describe, expect, it } from "vitest";
import { imageToolsFromMessages, toolImagePreviews } from "@/lib/chat/tool-images";
import type { WebMessage } from "@/lib/types";

const image = { type: "image" as const, data: "", mimeType: "image/png", url: "/api/sessions/s/images?entry=result&part=1" };
const call: WebMessage = { role: "assistant", id: "call", content: [{ type: "toolCall", id: "read", name: "read", arguments: { path: "picture.png" } }] };
const result: WebMessage = { role: "toolResult", id: "result", content: [{ type: "toolResult", toolCallId: "read", text: "Read image file", isError: false }, image] };

describe("durable image tool restoration", () => {
	it("restores the tool and image references when its live cache entry is absent", () => {
		const tools = imageToolsFromMessages([call, result]);
		expect(tools.read).toMatchObject({ name: "read", args: { path: "picture.png" }, state: "done", images: [image] });
		expect(toolImagePreviews("read", tools.read.args, tools.read)).toEqual([{ id: "read/0", path: "picture.png", image }]);
	});

	it("reuses unchanged image tool identities while another message streams", () => {
		const tools = imageToolsFromMessages([call, result]);
		const next = imageToolsFromMessages([call, result, { role: "assistant", content: [{ type: "text", text: "More output" }], stopReason: "pending" }]);
		expect(next.read).toBe(tools.read);
	});

	it("refreshes arguments when a delayed complete tool call replaces its partial block", () => {
		const tools = imageToolsFromMessages([call, result]);
		const updated: WebMessage = { ...call, content: [{ type: "toolCall", id: "read", name: "read", arguments: { path: "complete/picture.png" } }] };
		const next = imageToolsFromMessages([updated, result]);
		expect(next.read).not.toBe(tools.read);
		expect(next.read.args).toEqual({ path: "complete/picture.png" });
		expect(next.read.images).toEqual([image]);
	});

	it("does not invent successful image reads from filenames, failed results or orphan images", () => {
		expect(imageToolsFromMessages([call, { ...result, content: [result.content[0]] }])).toEqual({});
		expect(imageToolsFromMessages([result])).toEqual({});
		const failed: WebMessage = { ...result, content: [{ type: "toolResult", toolCallId: "read", text: "Permission denied", isError: true }, image] };
		const tools = imageToolsFromMessages([call, failed]);
		expect(toolImagePreviews("read", tools.read.args, tools.read)).toEqual([]);
	});
});
