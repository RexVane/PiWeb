// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { MarkdownBlock, StreamingMarkdownBlock } from "@/components/MarkdownBlock";

afterEach(cleanup);

describe("Mermaid Markdown fences (rendered as standard code blocks, no diagram image)", () => {
	it("renders closed Mermaid fences as ordinary code blocks", () => {
		const { container } = render(<MarkdownBlock text={'```mermaid\nflowchart LR\n A[中文] --> B[Next]\n```\n\n```ts\nconst a = 1;\n```'} />);
		expect(container.querySelector(".md-diagram")).toBeNull();
		expect(container.querySelector("pre code.language-mermaid")?.textContent).toContain("A[中文] --> B[Next]");
		expect(container.querySelector("pre code.language-ts")).not.toBeNull();
	});

	it("keeps incomplete fences as source during and after streaming", () => {
		const source = "```mermaid\nflowchart LR\n A --> B\n";
		const { container, rerender } = render(<StreamingMarkdownBlock text={source} />);
		expect(container.querySelector(".md-diagram")).toBeNull();
		rerender(<StreamingMarkdownBlock text={`${source}\u0060\u0060\u0060\n`} live={false} />);
		expect(container.querySelector(".md-diagram")).toBeNull();
		expect(container.querySelector("pre code")?.textContent).toContain("A --> B");
	});
});
