// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MermaidDiagram } from "@/components/MermaidDiagram";
import { renderMermaid, type MermaidImage } from "@/lib/mermaid";

vi.mock("@/lib/mermaid", () => ({ renderMermaid: vi.fn(), mermaidImageUrl: () => "data:image/svg+xml,test" }));
const image: MermaidImage = { svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 600"/>', width: 900, height: 600 };
beforeEach(() => {
	vi.mocked(renderMermaid).mockReset().mockResolvedValue(image);
});
afterEach(cleanup);

describe("Mermaid diagram display", () => {
	it("shows only the static image after rendering, without controls, title or source", async () => {
		const { container } = render(<MermaidDiagram source={"flowchart LR\n A --> B"} />);
		await screen.findByRole("img");
		expect(container.querySelector(".md-diagram")?.children).toHaveLength(1);
		expect(container.textContent).toBe("");
		expect(container.querySelector("button, details, summary, pre, code, [role=status]")).toBeNull();
		expect(screen.getByRole("img").getAttribute("width")).toBe("900");
	});

	it("preserves source on syntax failure without adding controls", async () => {
		vi.mocked(renderMermaid).mockRejectedValue(new Error("syntax"));
		const { container } = render(<MermaidDiagram source="invalid diagram" />);
		await screen.findByText("图表暂时无法绘制，源码保留在下方。");
		expect(container.querySelector("pre code")?.textContent).toBe("invalid diagram");
		expect(container.querySelector("img")).toBeNull();
		expect(container.querySelector("button")).toBeNull();
	});

	it("ignores stale render results after the source changes", async () => {
		let finishOld!: (value: MermaidImage) => void;
		vi.mocked(renderMermaid).mockReturnValueOnce(new Promise((resolve) => { finishOld = resolve; }));
		const { rerender } = render(<MermaidDiagram source="old" />);
		rerender(<MermaidDiagram source="new" />);
		await screen.findByRole("img");
		finishOld({ ...image, width: 1 });
		await waitFor(() => expect(screen.getByRole("img").getAttribute("width")).toBe("900"));
	});
});
