// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { ResourceFrame } from "@/components/resources/ResourceFrame";
import { ExtensionDialogHost } from "@/components/ExtensionUI";
import { RESOURCE_FRAME_CHANNEL, type WebResourceView } from "@/lib/resources/protocol";
import type { ExtensionDialog } from "@/hooks/usePiWeb";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const view: WebResourceView = { id: "user:custom:main", resourceId: "custom", scope: "user", title: "Custom", placement: "aboveEditor", methods: ["select"], url: "/api/resources/views/token/assets/index.html" };

function frameHost() {
	const result = render(<ResourceFrame view={view} cwd="/workspace" />);
	const frame = result.container.querySelector("iframe")!;
	const post = vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation(() => {});
	const receive = (data: Record<string, unknown>, source = frame.contentWindow!) => fireEvent(window, new MessageEvent("message", { source, data: { channel: RESOURCE_FRAME_CHANNEL, ...data } }));
	receive({ type: "ready" });
	const context = post.mock.calls.find(([message]) => message.type === "context")![0];
	return { ...result, frame, post, receive, token: context.token as string, context: context.context };
}

describe("generic resource frame focus", () => {
	it("advertises support and grants idle-page focus without a backend request", () => {
		const { frame, post, receive, token, context } = frameHost();
		expect(context.focusRequestSupported).toBe(true);
		receive({ type: "focus", token, id: "f1" });
		expect(document.activeElement).toBe(frame);
		expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: "result", id: "f1", value: true }), "*");
	});
	it("refuses to steal focus from a user input and rejects foreign or unbound messages", () => {
		const { frame, post, receive, token, container } = frameHost();
		const input = document.createElement("input"); container.appendChild(input); input.focus();
		receive({ type: "focus", token, id: "f2" });
		expect(document.activeElement).toBe(input);
		expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: "result", id: "f2", value: false }), "*");
		post.mockClear();
		receive({ type: "focus", token: "wrong", id: "f3" });
		receive({ type: "focus", token, id: "f4" }, window);
		expect(post).not.toHaveBeenCalled(); expect(document.activeElement).not.toBe(frame);
	});
	it("retains the iframe across context updates and permits content to shrink", () => {
		const { frame, receive, token, container, rerender } = frameHost();
		receive({ type: "resize", token, height: 370 }); expect(frame.style.height).toBe("370px");
		receive({ type: "resize", token, height: 130 }); expect(frame.style.height).toBe("130px");
		rerender(<ResourceFrame view={view} cwd="/workspace" data={{ updated: true }} />);
		expect(container.querySelector("iframe")).toBe(frame);
		expect(frame.className).not.toContain("rounded");
	});
	it("does not focus or restore focus for an embedded extension request", () => {
		const first = document.createElement("input"); const second = document.createElement("input");
		document.body.append(first, second); first.focus();
		const dialog: ExtensionDialog = { id: "request", method: "resource", title: "Custom", resourceView: view, ts: Date.now() };
		const { unmount } = render(<ExtensionDialogHost dialog={dialog} embedded cwd="/workspace" onAnswer={vi.fn()} />);
		expect(document.activeElement).toBe(first);
		second.focus(); unmount(); expect(document.activeElement).toBe(second);
		first.remove(); second.remove();
	});
});
