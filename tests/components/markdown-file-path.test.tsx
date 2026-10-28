// @vitest-environment jsdom
/**
 * 行内代码里的文件路径可点；代码块不参与。
 * 回归：只靠 className 区分代码块，不写语言的围栏 / 缩进代码块没有 className，
 * 里面只有一行路径时整个代码块被渲染成了按钮（丢了 pre 的样式和复制按钮的对象）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MarkdownBlock } from "@/components/MarkdownBlock";
import { MarkdownActionsProvider } from "@/components/chat/markdown-actions";

afterEach(cleanup);

function renderMd(text: string) {
	const openFile = vi.fn();
	const view = render(
		<MarkdownActionsProvider value={{ openFile }}>
			<MarkdownBlock text={text} />
		</MarkdownActionsProvider>,
	);
	return { ...view, openFile };
}

describe("file paths in markdown", () => {
	it("turns an inline code path into a button", () => {
		const { container } = renderMd("改了 `src/lib/a.ts` 这个文件");
		const button = container.querySelector("button.md-file-path");
		expect(button?.textContent).toBe("src/lib/a.ts");
	});

	it("leaves a fenced block without a language as code even when it holds a single path", () => {
		const { container } = renderMd("```\nsrc/lib/a.ts\n```");
		expect(container.querySelector("button.md-file-path")).toBeNull();
		expect(container.querySelector("pre > code")?.textContent).toBe("src/lib/a.ts\n");
	});

	it("leaves an indented code block as code too", () => {
		const { container } = renderMd("说明：\n\n    src/lib/a.ts\n");
		expect(container.querySelector("button.md-file-path")).toBeNull();
		expect(container.querySelector("pre > code")).not.toBeNull();
	});

	it("opens explicit relative Markdown links in the file viewer, decoding the path once", () => {
		const { openFile } = renderMd("[文件](docs/%E4%B8%AD%E6%96%87%20file.md?raw=1#L2) [README](README.md) [目录](src/) [无扩展名](./LICENSE)");
		for (const name of ["文件", "README", "目录", "无扩展名"]) fireEvent.click(screen.getByRole("link", { name }));
		expect(openFile.mock.calls.map(([path]) => path)).toEqual(["docs/中文 file.md", "README.md", "src/", "./LICENSE"]);
	});

	it("preserves external, anchor, email and application links", () => {
		const { openFile } = renderMd("[外部](https://example.com/a.md) [锚点](#section) [邮件](mailto:test@example.com) [站内](/login)");
		for (const name of ["外部", "锚点", "邮件", "站内"]) {
			const link = screen.getByRole("link", { name });
			const event = new MouseEvent("click", { bubbles: true, cancelable: true });
			let preventedByMarkdown: boolean | undefined;
			const suppressNavigation = (received: Event) => { preventedByMarkdown = received.defaultPrevented; received.preventDefault(); };
			document.addEventListener("click", suppressNavigation, { once: true });
			link.dispatchEvent(event);
			expect(preventedByMarkdown).toBe(false);
		}
		expect(openFile).not.toHaveBeenCalled();
	});
});
