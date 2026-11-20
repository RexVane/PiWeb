// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ChatWindow } from "@/components/ChatWindow";
import { ViewedImages } from "@/components/chat/viewed-images";
import { foldPiWebEvent, type PiWebState, type ToolCardState } from "@/hooks/usePiWeb";
import { MAX_VISIBLE_TOOLS } from "@/lib/chat/web-history";
import type { WebContent, WebMessage } from "@/lib/types";

const first = { type: "image" as const, data: "Zmlyc3Q=", mimeType: "image/png" };
const second = { type: "image" as const, data: "c2Vjb25k", mimeType: "image/jpeg" };
const call = (id: string, path: string): Extract<WebContent, { type: "toolCall" }> => ({ type: "toolCall", id, name: "read", arguments: { path } });
const message = (content: WebContent[], id = "a1"): WebMessage => ({ role: "assistant", id, content, stopReason: "toolUse", timestamp: 1000 });
const done = (path: string, images = [first]): ToolCardState => ({ name: "read", args: { path }, state: "done", images, result: "Read image file [image/png]" });
afterEach(cleanup);

describe("viewed image process steps", () => {
	it("groups consecutive image reads into a collapsed count, then thumbnails and a read-only gallery", () => {
		const onOpenFile = vi.fn();
		const { container } = render(<ChatWindow messages={[message([call("r1", "/workspace/first.png"), call("r2", "/workspace/second.jpg")])]} tools={{ r1: done("/workspace/first.png"), r2: done("/workspace/second.jpg", [second]) }} cwd="/workspace" onOpenFile={onOpenFile} />);
		const summary = screen.getByRole("button", { name: "已查看 2 张图像" });
		expect(summary.getAttribute("aria-expanded")).toBe("false");
		expect(screen.queryByRole("img")).toBeNull();
		expect(container.querySelectorAll('.pw-step[data-kind="image"]')).toHaveLength(1);
		expect(container.querySelector(".pw-summary")).toBeNull();
		expect(screen.queryByText("Read image file [image/png]")).toBeNull();

		fireEvent.click(summary);
		expect(summary.getAttribute("aria-expanded")).toBe("true");
		const thumbs = screen.getAllByRole("img");
		expect(thumbs).toHaveLength(2);
		expect(thumbs[0].getAttribute("loading")).toBe("lazy");
		expect(thumbs[0].getAttribute("src")).toContain(first.data);
		fireEvent.click(screen.getByRole("button", { name: "first.png" }));
		expect(onOpenFile).toHaveBeenCalledWith("/workspace/first.png");

		const opener = screen.getByRole("button", { name: "点击放大预览: second.jpg" });
		opener.focus();
		fireEvent.click(opener);
		const dialog = screen.getByRole("dialog", { name: "图片预览" });
		expect(dialog.parentElement).toBe(document.body);
		expect(within(dialog).getByRole("img").getAttribute("src")).toContain(second.data);
		expect(within(dialog).getByText("2 / 2")).toBeTruthy();
		expect(within(dialog).queryByRole("button", { name: "删除" })).toBeNull();
		expect(document.body.style.overflow).toBe("hidden");
		fireEvent.keyDown(document, { key: "ArrowLeft" });
		expect(within(dialog).getByRole("img").getAttribute("src")).toContain(first.data);
		fireEvent.click(within(dialog).getByRole("button", { name: "上一张" }));
		expect(within(dialog).getByRole("img").getAttribute("src")).toContain(second.data);
		fireEvent.keyDown(document, { key: "Escape" });
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(document.activeElement).toBe(opener);
		expect(document.body.style.overflow).toBe("");

		fireEvent.click(summary);
		expect(screen.queryByRole("img")).toBeNull();
	});

	it("counts returned images rather than tool calls, and uses persisted image URLs", () => {
		const url = "/api/sessions/s/images?entry=result&part=1";
		const stored = { ...first, data: "", url };
		render(<ChatWindow messages={[message([call("r1", "screenshots")])]} tools={{ r1: done("screenshots", [stored, second]) }} />);
		fireEvent.click(screen.getByRole("button", { name: "已查看 2 张图像" }));
		expect(screen.getAllByRole("img")[0].getAttribute("src")).toBe(url);
		fireEvent.click(screen.getAllByRole("button", { name: /点击放大预览:/ })[0]);
		expect(within(screen.getByRole("dialog")).getByRole("img").getAttribute("src")).toBe(url);
	});

	it("keeps the singular image row independent of ordinary read/think summaries", () => {
		const calls = message([
			{ type: "thinking", thinking: "Check both inputs" },
			call("r1", "first.png"),
			call("r2", "notes.txt"),
		]);
		const { container } = render(<ChatWindow messages={[calls]} tools={{ r1: done("first.png"), r2: { name: "read", args: { path: "notes.txt" }, state: "done", result: "notes" } }} />);
		expect(screen.getByRole("button", { name: "已查看 1 张图像" })).toBeTruthy();
		expect(container.querySelector(".pw-summary")?.textContent).toContain("读了 1 个文件");
		expect(container.querySelectorAll('.pw-step[data-kind="image"]')).toHaveLength(1);
	});

	it("does not guess from extensions or mark failed/running image reads as viewed", () => {
		const { container } = render(<ChatWindow messages={[message([call("running", "first.png"), call("error", "bad.jpg"), call("text", "not-an-image.png")])]} tools={{
			running: { ...done("first.png"), state: "running" },
			error: { ...done("bad.jpg"), isError: true, result: "Permission denied" },
			text: { name: "read", args: { path: "not-an-image.png" }, state: "done", result: "plain text" },
		}} isStreaming />);
		expect(screen.queryByRole("button", { name: /已查看 .* 张图像/ })).toBeNull();
		expect(container.querySelector('.pw-step[data-tone="fail"]')?.textContent).toContain("Permission denied");
		expect(screen.getByText("not-an-image.png")).toBeTruthy();
	});

	it("preserves skill and narration boundaries rather than merging unrelated image reads", () => {
		const { container } = render(<ChatWindow messages={[message([
			call("r1", "first.png"),
			call("skill", "/skills/review/SKILL.md"),
			call("r2", "second.jpg"),
			{ type: "text", text: "A separate step" },
			call("r3", "third.png"),
		])]} tools={{ r1: done("first.png"), skill: { name: "read", args: { path: "/skills/review/SKILL.md" }, state: "done", result: "# Review" }, r2: done("second.jpg", [second]), r3: done("third.png") }} />);
		expect(screen.getAllByRole("button", { name: "已查看 1 张图像" })).toHaveLength(3);
		expect(container.querySelector('.pw-step[data-kind="skill"]')?.textContent).toContain("review");
	});

	it("groups consecutive reads across assistant messages, including completed history", () => {
		const messages: WebMessage[] = [
			message([call("r1", "first.png")]),
			message([call("r2", "second.jpg")], "a2"),
			{ role: "assistant", id: "a3", content: [{ type: "text", text: "Done" }], stopReason: "stop", timestamp: 2000 },
		];
		const { container } = render(<ChatWindow messages={messages} tools={{ r1: done("first.png"), r2: done("second.jpg", [second]) }} />);
		fireEvent.click(container.querySelector(".pw-turn-toggle")!);
		expect(screen.getByRole("button", { name: "已查看 2 张图像" })).toBeTruthy();
		expect(screen.queryByRole("img")).toBeNull();
	});

	it("preserves an expanded gallery and its selected image as another read finishes", () => {
		const initial = message([call("r1", "first.png"), call("r2", "second.jpg")]);
		const view = render(<ChatWindow messages={[initial]} tools={{ r1: done("first.png"), r2: { ...done("second.jpg", []), state: "running" } }} isStreaming />);
		fireEvent.click(screen.getByRole("button", { name: "已查看 1 张图像" }));
		fireEvent.click(screen.getByRole("button", { name: "点击放大预览: first.png" }));
		view.rerender(<ChatWindow messages={[initial]} tools={{ r1: done("first.png"), r2: done("second.jpg", [second]) }} isStreaming />);
		const dialog = screen.getByRole("dialog");
		expect(screen.getByRole("button", { name: "已查看 2 张图像" }).getAttribute("aria-expanded")).toBe("true");
		expect(within(dialog).getByRole("img").getAttribute("src")).toContain(first.data);
		expect(within(dialog).getByText("1 / 2")).toBeTruthy();
		fireEvent.click(within(dialog).getByRole("button", { name: "下一张" }));
		expect(within(dialog).getByRole("img").getAttribute("src")).toContain(second.data);
	});

	it("renders a nested read's image count within its parent tool", () => {
		const { container } = render(<ChatWindow messages={[message([{ type: "toolCall", id: "parent", name: "codemode", arguments: { script: "read an image" } }])]} tools={{ parent: { name: "codemode", args: {}, state: "done", result: "ok", children: ["parent/1"] }, "parent/1": { ...done("first.png"), parentId: "parent" } }} />);
		const summary = screen.getByRole("button", { name: "已查看 1 张图像" });
		expect(container.querySelector(".pw-nested")?.contains(summary)).toBe(true);
		fireEvent.click(summary);
		fireEvent.click(screen.getByRole("button", { name: "点击放大预览: first.png" }));
		expect(screen.getByRole("dialog")).toBeTruthy();
	});

	it("also makes images returned by other tools available without discarding their output", () => {
		render(<ChatWindow messages={[message([{ type: "toolCall", id: "view", name: "view_image", arguments: {} }])]} tools={{ view: { name: "view_image", args: {}, state: "done", result: "Screenshot captured", images: [first] } }} />);
		fireEvent.click(screen.getByRole("button", { name: /^View_image/ }));
		expect(screen.getByText("Screenshot captured")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "已查看 1 张图像" }));
		expect(screen.getByRole("img").getAttribute("src")).toContain(first.data);
	});

	it("keeps an image-bearing command independent of ordinary command summaries", () => {
		const { container } = render(<ChatWindow messages={[message([{ type: "toolCall", id: "capture", name: "bash", arguments: { command: "screenshot" } }])]} tools={{ capture: { name: "bash", args: { command: "screenshot" }, state: "done", result: "Screenshot captured", images: [first] } }} />);
		expect(container.querySelector(".pw-summary")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "已查看 1 张图像" }));
		expect(screen.getByRole("img").getAttribute("src")).toContain(first.data);
	});

	it("keeps an expanded historical image gallery after newer events evict its live tool cache entry", () => {
		const stored = { ...first, data: "", url: "/api/sessions/s/images?entry=result&part=1" };
		const result: WebMessage = { role: "toolResult", id: "result", content: [{ type: "toolResult", toolCallId: "r1", text: "Read image file", isError: false }, stored] };
		const messages = [message([call("r1", "first.png")]), result];
		let state = { messages, tools: { r1: done("first.png", [stored]) }, compaction: null } as unknown as PiWebState;
		const view = render(<ChatWindow messages={state.messages} tools={state.tools} />);
		fireEvent.click(screen.getByRole("button", { name: "已查看 1 张图像" }));
		for (let index = 0; index < MAX_VISIBLE_TOOLS; index++) {
			state = foldPiWebEvent(state, { type: "tool", id: `new-${index}`, name: "read", state: "done", ts: index + 1 });
		}
		expect(state.tools.r1).toBeUndefined();
		expect(Object.keys(state.tools)).toHaveLength(MAX_VISIBLE_TOOLS);
		view.rerender(<ChatWindow messages={state.messages} tools={state.tools} />);
		expect(screen.getByRole("button", { name: "已查看 1 张图像" }).getAttribute("aria-expanded")).toBe("true");
		fireEvent.click(screen.getByRole("button", { name: "点击放大预览: first.png" }));
		expect(within(screen.getByRole("dialog")).getByRole("img").getAttribute("src")).toBe(stored.url);
	});

	it("does not request an unsafe image URL or open an empty viewer", () => {
		render(<ViewedImages images={[{ id: "read/0", image: { ...first, url: "https://external.example/private.png" } }]} />);
		fireEvent.click(screen.getByRole("button", { name: "已查看 1 张图像" }));
		const opener = screen.getByRole("button", { name: "点击放大预览: #1" });
		expect(opener.hasAttribute("disabled")).toBe(true);
		expect(screen.getByRole("img").getAttribute("src")).toBeNull();
		fireEvent.click(opener);
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("closes the viewer if the selected image changes while preserving the expanded thumbnails", () => {
		const view = render(<ViewedImages images={[{ id: "read/0", image: first }]} />);
		fireEvent.click(screen.getByRole("button", { name: "已查看 1 张图像" }));
		fireEvent.click(screen.getByRole("button", { name: "点击放大预览: #1" }));
		view.rerender(<ViewedImages images={[{ id: "read/0", image: second }]} />);
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(document.body.style.overflow).toBe("");
		expect(screen.getByRole("img").getAttribute("src")).toContain(second.data);
	});
});
