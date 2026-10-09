// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ChatWindow } from "@/components/chat/ChatWindow";
import { foldPiWebEvent, type PiWebState } from "@/hooks/usePiWeb";
import { toWebMessage } from "@/lib/agent/agent-manager";
import type { WebMessage } from "@/lib/types";

afterEach(() => { cleanup(); });

describe("tool result images (pi's eyes)", () => {
	it("projects screenshot images out of a tool result without leaking them into the text", () => {
		const message = toWebMessage({
			role: "toolResult",
			toolCallId: "call-1",
			content: [{ type: "text", text: "Page: App — http://localhost:5173/" }, { type: "image", data: "JPEGDATA", mimeType: "image/jpeg" }],
		});
		expect(message.content).toEqual([expect.objectContaining({ type: "toolResult", toolCallId: "call-1", text: "Page: App — http://localhost:5173/", images: [{ data: "JPEGDATA", mimeType: "image/jpeg" }] })]);
	});

	it("keeps live tool event images in the tool state", () => {
		const state = foldPiWebEvent({ tools: {} } as unknown as PiWebState, {
			type: "tool", id: "call-1", name: "browser_open", args: { url: "http://localhost:5173" }, state: "done", result: "Page: App", images: [{ data: "JPEGDATA", mimeType: "image/jpeg" }], ts: 2,
		});
		expect(state.tools["call-1"].images).toEqual([{ data: "JPEGDATA", mimeType: "image/jpeg" }]);
	});

	it("shows the screenshot under the tool line and zooms it until Escape", () => {
		const messages: WebMessage[] = [
			{ id: "u1", role: "user", content: [{ type: "text", text: "看看页面" }], timestamp: 1 },
			{ id: "a1", role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "browser_open", arguments: { url: "http://localhost:5173" } }], stopReason: "toolUse", timestamp: 2 },
			{ id: "a2", role: "assistant", content: [{ type: "text", text: "页面正常" }], stopReason: "stop", timestamp: 3 },
		];
		const tools = { "call-1": { name: "browser_open", args: { url: "http://localhost:5173" }, state: "done" as const, result: "Page: App", images: [{ data: "JPEGDATA", mimeType: "image/jpeg" }] } };
		render(<ChatWindow messages={messages} tools={tools} />);
		const shots = screen.getByTestId("tool-shots");
		const img = shots.querySelector("img")!;
		expect(img.getAttribute("src")).toBe("data:image/jpeg;base64,JPEGDATA");
		expect(screen.getByText(/打开页面|Opened page/)).toBeTruthy();
		fireEvent.click(shots.querySelector("button")!);
		expect(screen.getByRole("dialog")).toBeTruthy();
		fireEvent.keyDown(document, { key: "Escape" });
		expect(screen.queryByRole("dialog")).toBeNull();
	});
});
