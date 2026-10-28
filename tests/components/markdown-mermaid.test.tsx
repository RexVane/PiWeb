// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { MarkdownBlock, StreamingMarkdownBlock } from "@/components/MarkdownBlock";

vi.mock("@/components/MermaidDiagram", () => ({ MermaidDiagram: ({ source }: { source: string }) => <figure data-diagram={source} /> }));
afterEach(cleanup);

describe("Mermaid Markdown integration", () => {
	it("renders closed Mermaid fences without changing ordinary code blocks", () => {
		const { container } = render(<MarkdownBlock text={'```mermaid\nflowchart LR\n A[中文] --> B[Next]\n```\n\n```ts\nconst a = 1;\n```'} />);
		expect(container.querySelector("figure")?.getAttribute("data-diagram")).toBe("flowchart LR\n A[中文] --> B[Next]");
		expect(container.querySelector("pre code.language-ts")).not.toBeNull();
	});

	it("keeps incomplete fences as source, even in a saved message", () => {
		const { container } = render(<MarkdownBlock text={"```mermaid\nflowchart LR\n A --> B"} />);
		expect(container.querySelector("figure")).toBeNull();
		expect(container.querySelector("pre code")?.textContent).toContain("A --> B");
	});

	it("waits for the closing fence during streaming, then keeps the diagram after completion", () => {
		const source = "```mermaid\nflowchart LR\n A --> B\n";
		const { container, rerender } = render(<StreamingMarkdownBlock text={source} />);
		expect(container.querySelector("figure")).toBeNull();
		rerender(<StreamingMarkdownBlock text={`${source}\u0060\u0060\u0060\n`} />);
		expect(container.querySelector("figure")?.getAttribute("data-diagram")).toContain("A --> B");
		rerender(<StreamingMarkdownBlock text={`${source}\u0060\u0060\u0060\n`} live={false} />);
		expect(container.querySelectorAll("figure")).toHaveLength(1);
	});

	it("accepts tilde fences and requires a matching closing marker", () => {
		const { container, rerender } = render(<MarkdownBlock text={"~~~~mermaid\nflowchart LR\n A --> B\n~~~"} />);
		expect(container.querySelector("figure")).toBeNull();
		rerender(<MarkdownBlock text={"~~~~mermaid\nflowchart LR\n A --> B\n~~~~"} />);
		expect(container.querySelector("figure")).not.toBeNull();
	});
});
