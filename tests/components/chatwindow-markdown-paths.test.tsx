// @vitest-environment jsdom
/**
 * 正文行内代码里的文件路径点开的是**页内文件查看器**（PiWeb 自己的 FileViewer），
 * 不是本机编辑器。
 *
 * 为什么这条要单独锁住：#144 引入这个功能时，接线复用了工具行那个「在编辑器中打开」的
 * 回调（openInEditor → spawn `code`），于是「点路径」会跳到编辑器，和当初设计的
 * 「查看器对不存在的路径会体面报错」对不上。现在两者分开：
 *   - 正文路径（onOpenPath）→ viewer.open
 *   - 工具行按钮（onOpenFile）→ openInEditor
 * 这条测试就是守这个边界：将来谁把它们又合回一个 prop，会红。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ChatWindow } from "@/components/ChatWindow";
import type { WebMessage } from "@/lib/types";

afterEach(cleanup);

/** Markdown 在 ChatWindow 里是懒加载分块，首次呈现要现场转换整个依赖图 */
const MARKDOWN_READY_TIMEOUT_MS = 20_000;
const FILE_PATH = "src/components/SettingsPanel.tsx";
const PATH_SELECTOR = "button.md-file-path";

const answer = {
	role: "assistant",
	id: "a1",
	content: [{ type: "text", text: `入口在 \`${FILE_PATH}\` 里。` }],
	stopReason: "stop",
	timestamp: 1,
} as unknown as WebMessage;

/** 一次 write 工具调用：write 不会折进「运行 N 步」的折叠块，工具行上会渲染「在编辑器中打开」按钮 */
const writeCall = {
	role: "assistant",
	id: "a2",
	content: [
		{ type: "toolCall", id: "c1", name: "write", arguments: { path: FILE_PATH, content: "export {};\n" } },
		{ type: "text", text: "写完了。" },
	],
	stopReason: "stop",
	timestamp: 2,
} as unknown as WebMessage;
const writeTools = { c1: { name: "write", args: { path: FILE_PATH, content: "export {};\n" }, state: "done" as const, result: "ok" } };

/** 等 Markdown 分块加载并渲染出可点的路径按钮，返回它本身（waitFor 的返回值不是元素） */
async function pathButton(): Promise<HTMLElement> {
	await waitFor(() => expect(document.querySelector(PATH_SELECTOR)).toBeTruthy(), { timeout: MARKDOWN_READY_TIMEOUT_MS });
	return document.querySelector(PATH_SELECTOR) as HTMLElement;
}

describe("正文里的文件路径点击", () => {
	it("走页内查看器（onOpenPath），不碰本机编辑器（onOpenFile）", async () => {
		const openPath = vi.fn();
		const openEditor = vi.fn();
		render(<ChatWindow messages={[answer]} tools={{}} onOpenPath={openPath} onOpenFile={openEditor} />);
		fireEvent.click(await pathButton());
		expect(openPath).toHaveBeenCalledWith(FILE_PATH);
		expect(openEditor).not.toHaveBeenCalled();
	}, 30_000);

	it("没接查看器时退回本机编辑器：单独用 ChatWindow 的地方不会变成点不动", async () => {
		const openEditor = vi.fn();
		render(<ChatWindow messages={[answer]} tools={{}} onOpenFile={openEditor} />);
		fireEvent.click(await pathButton());
		expect(openEditor).toHaveBeenCalledWith(FILE_PATH);
	}, 30_000);

	it("工具行上那个「在编辑器中打开」按钮仍然是本机编辑器", async () => {
		const openPath = vi.fn();
		const openEditor = vi.fn();
		render(<ChatWindow messages={[writeCall]} tools={writeTools} onOpenPath={openPath} onOpenFile={openEditor} />);
		fireEvent.click(await screen.findByRole("button", { name: "在编辑器中打开" }));
		expect(openEditor).toHaveBeenCalledWith(FILE_PATH);
		expect(openPath).not.toHaveBeenCalled();
	}, 30_000);
});
