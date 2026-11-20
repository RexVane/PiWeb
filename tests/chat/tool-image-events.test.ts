import { describe, expect, it } from "vitest";
import { foldPiWebEvent, type PiWebState, type ToolCardState } from "@/hooks/usePiWeb";
import type { WebMessage } from "@/lib/types";

const image = { type: "image" as const, data: "", mimeType: "image/png", url: "/api/sessions/s/images?entry=result&part=1" };
const tool: ToolCardState = { name: "read", args: { path: "picture.png" }, state: "done", result: "Read image file [image/png]", startedAt: 1, endedAt: 2 };
const result: WebMessage = { id: "result", role: "toolResult", content: [{ type: "toolResult", toolCallId: "read", text: "Read image file [image/png]", isError: false }, image] };
const base = (messages: WebMessage[] = []) => ({ messages, tools: { read: tool }, compaction: null } as unknown as PiWebState);

describe("tool image event folding", () => {
	it("attaches durable image previews to the completed tool without mutating existing state", () => {
		const initial = base();
		const next = foldPiWebEvent(initial, { type: "message", phase: "end", message: result, ts: 3 });
		expect(next.tools.read).toEqual({ ...tool, images: [image], isError: false });
		expect(next.tools.read).not.toBe(tool);
		expect(initial.tools.read.images).toBeUndefined();
		expect(next.messages).toEqual([result]);
		const replay = foldPiWebEvent(next, { type: "message", phase: "end", message: result, ts: 3 });
		expect(replay.tools.read.images).toEqual([image]);
		expect(replay.messages).toEqual([result]);
		// Later lifecycle frames must not discard the images from the authoritative result.
		expect(foldPiWebEvent(replay, { type: "tool", id: "read", name: "read", state: "done", ts: 4 }).tools.read.images).toEqual([image]);
	});

	it("also applies a delayed result already present in the reconnect snapshot", () => {
		const initial = base([{ ...result, content: [result.content[0]] }]);
		const next = foldPiWebEvent(initial, { type: "message", phase: "end", message: result, ts: 3 });
		expect(next.messages).toEqual([result]);
		expect(next.tools.read.images).toEqual([image]);
		expect(initial.messages[0].content).toHaveLength(1);
	});

	it("retains bounded inline images on nested tool completion and preserves its parent linkage", () => {
		const initial = { ...base(), tools: { parent: { name: "codemode", args: {}, state: "running" } } } as PiWebState;
		const inline = { type: "image" as const, data: "Zmlyc3Q=", mimeType: "image/png" };
		const started = foldPiWebEvent(initial, { type: "tool", id: "parent/1", name: "read", args: { path: "picture.png" }, parentId: "parent", state: "running", ts: 1 });
		const next = foldPiWebEvent(started, { type: "tool", id: "parent/1", name: "read", parentId: "parent", state: "done", images: [inline], ts: 2 });
		expect(next.tools["parent/1"]).toMatchObject({ images: [inline], parentId: "parent", args: { path: "picture.png" } });
		expect(next.tools.parent.children).toEqual(["parent/1"]);
		const tooLarge = foldPiWebEvent(started, { type: "tool", id: "parent/1", name: "read", state: "done", images: [{ ...inline, data: "A".repeat(3_000_001) }], ts: 2 });
		expect(tooLarge.tools["parent/1"].images).toEqual([]);
	});

	it("clears a snapshot's stale image preview when the authoritative end removes the images", () => {
		const initial = { ...base([result]), tools: { read: { ...tool, images: [image] } } } as PiWebState;
		const textOnly: WebMessage = { ...result, content: [result.content[0]] };
		const next = foldPiWebEvent(initial, { type: "message", phase: "end", message: textOnly, ts: 3 });
		expect(next.tools.read.images).toEqual([]);
		expect(next.messages).toEqual([textOnly]);
		expect(initial.tools.read.images).toEqual([image]);
	});

	it("recovers an evicted tool from its message arguments when its durable image result arrives", () => {
		const call: WebMessage = { role: "assistant", content: [{ type: "toolCall", id: "read", name: "read", arguments: { path: "picture.png" } }] };
		const initial = { ...base([call]), tools: {} } as PiWebState;
		const next = foldPiWebEvent(initial, { type: "message", phase: "end", message: result, ts: 3 });
		expect(next.tools.read).toMatchObject({ state: "done", name: "read", args: { path: "picture.png" }, images: [image] });
		expect(next.messages).toEqual([call, result]);
		expect(initial.tools).toEqual({});
	});

	it("keeps the legacy text-only tool-result path out of the live message list", () => {
		const initial = base();
		const textOnly: WebMessage = { ...result, content: [result.content[0]] };
		const next = foldPiWebEvent(initial, { type: "message", phase: "end", message: textOnly, ts: 3 });
		expect(next.messages).toEqual([]);
		expect(next.tools).toBe(initial.tools);
	});

	it("does not attach an orphan result to another tool or consume partial message images", () => {
		const initial = base();
		const orphan: WebMessage = { ...result, content: [{ type: "toolResult", toolCallId: "missing", text: "" }, image] };
		expect(foldPiWebEvent(initial, { type: "message", phase: "end", message: orphan, ts: 3 }).tools.read).toBe(tool);
		expect(foldPiWebEvent(initial, { type: "message", phase: "start", message: result, ts: 3 }).tools.read).toBe(tool);
	});
});
