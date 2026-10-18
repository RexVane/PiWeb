// @vitest-environment jsdom
/**
 * 行内代码里的文件路径可点；代码块不参与。
 * 回归：只靠 className 区分代码块，不写语言的围栏 / 缩进代码块没有 className，
 * 里面只有一行路径时整个代码块被渲染成了按钮（丢了 pre 的样式和复制按钮的对象）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
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
});
