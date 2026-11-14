// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MarkdownBlock } from "@/components/MarkdownBlock";

afterEach(cleanup);

describe("MarkdownBlock table scroll & code block UX", () => {
	it("wraps Markdown tables inside .md-table-wrap without breaking table markup", () => {
		const md = "| 列1 | 列2 | 列3 |\n| --- | --- | --- |\n| a | b | c |";
		const { container } = render(<MarkdownBlock text={md} />);
		const table = container.querySelector(".md-table-wrap > table");
		expect(table).not.toBeNull();
		expect(table?.querySelectorAll("th")).toHaveLength(3);
	});

	it("preserves .md-code-block > pre > code hierarchy and toggles word-wrap", () => {
		const { container } = render(<MarkdownBlock text={"```ts\nconst x = 1;\n```"} />);
		const block = container.querySelector(".md-code-block")!;
		const code = container.querySelector(".md-code-block > pre > code");
		expect(code?.textContent).toBe("const x = 1;\n");
		expect(block.getAttribute("data-wrapped")).toBeNull();
		expect(container.querySelector(".md-code-fold-bar")).toBeNull();

		const wrapBtn = screen.getByRole("button", { name: "开启自动换行" });
		fireEvent.click(wrapBtn);
		expect(block.getAttribute("data-wrapped")).toBe("true");
		expect(screen.getByRole("button", { name: "取消自动换行" }).getAttribute("aria-pressed")).toBe("true");
	});

	it("collapses settled tall code blocks by default and expands on click", () => {
		const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
		const { container } = render(<MarkdownBlock text={`\`\`\`txt\n${lines}\n\`\`\``} />);
		const block = container.querySelector(".md-code-block")!;
		expect(block.getAttribute("data-collapsed")).toBe("true");

		const expandBtn = screen.getByRole("button", { name: "展开全部 30 行" });
		expect(expandBtn.getAttribute("aria-expanded")).toBe("false");
		fireEvent.click(expandBtn);

		expect(block.getAttribute("data-collapsed")).toBeNull();
		expect(screen.getByRole("button", { name: "收起代码" }).getAttribute("aria-expanded")).toBe("true");
	});
});
