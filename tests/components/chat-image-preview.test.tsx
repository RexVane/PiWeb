// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ChatWindow } from "@/components/ChatWindow";
import { PreviewImage } from "@/components/PreviewImage";
import { MarkdownBlock } from "@/components/MarkdownBlock";
import type { WebMessage } from "@/lib/types";

const image = (data: string) => ({ type: "image" as const, mimeType: "image/png", data });
const first = image("Zmlyc3Q=");
const second = image("c2Vjb25k");
afterEach(cleanup);

describe("chat image previews", () => {
	it("opens sent user images as a read-only gallery, navigates, and restores focus and scrolling", () => {
		const messages = [{ role: "user", content: [first, second], timestamp: 1000 }] as WebMessage[];
		render(<ChatWindow messages={messages} tools={{}} isStreaming={false} />);
		const opener = screen.getAllByRole("button", { name: "点击放大预览" })[0];
		opener.focus();
		fireEvent.click(opener);
		const dialog = screen.getByRole("dialog", { name: "图片预览" });
		expect(dialog.parentElement).toBe(document.body);
		expect(within(dialog).queryByRole("button", { name: "删除" })).toBeNull();
		expect(within(dialog).getByRole("img").getAttribute("src")).toContain(first.data);
		expect(document.body.style.overflow).toBe("hidden");
		fireEvent.keyDown(document, { key: "ArrowRight" });
		expect(within(dialog).getByRole("img").getAttribute("src")).toContain(second.data);
		fireEvent.click(within(dialog).getByRole("button", { name: "下一张" }));
		expect(within(dialog).getByRole("img").getAttribute("src")).toContain(first.data);
		fireEvent.keyDown(document, { key: "Escape" });
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(document.activeElement).toBe(opener);
		expect(document.body.style.overflow).toBe("");
	});

	it.each(["toolUse", "stop"])("opens assistant images in %s messages", (stopReason) => {
		const messages = [{ role: "assistant", content: [{ type: "text", text: "Result" }, first], stopReason, timestamp: 1000 }] as WebMessage[];
		render(<ChatWindow messages={messages} tools={{}} isStreaming={false} />);
		fireEvent.click(screen.getByRole("button", { name: "点击放大预览" }));
		expect(screen.getByRole("dialog")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "关闭" }));
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("keeps focus in the viewer and only closes on the backdrop, not the image", () => {
		render(<PreviewImage image={first} />);
		fireEvent.click(screen.getByRole("button", { name: "点击放大预览" }));
		const dialog = screen.getByRole("dialog");
		const close = within(dialog).getByRole("button", { name: "关闭" });
		fireEvent.keyDown(document, { key: "Tab" });
		expect(document.activeElement).toBe(close);
		fireEvent.click(within(dialog).getByRole("img"));
		expect(screen.getByRole("dialog")).toBeTruthy();
		fireEvent.click(dialog);
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("does not load external Markdown images until approved, then supports preview", () => {
		const { container } = render(<MarkdownBlock text="![example](https://external.example/image.png)" />);
		expect(container.querySelector("img")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: /外部图片，点击加载/ }));
		fireEvent.click(screen.getByRole("button", { name: "点击放大预览: example" }));
		expect(within(screen.getByRole("dialog")).getByRole("img").getAttribute("src")).toBe("https://external.example/image.png");
	});
});
