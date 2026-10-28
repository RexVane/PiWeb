// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertStaticMermaid, renderMermaid, sanitizeMermaidSvg } from "@/lib/mermaid";

const sdk = vi.hoisted(() => ({ initialize: vi.fn(), render: vi.fn() }));
vi.mock("mermaid", () => ({ default: sdk }));
const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 400"><text>中文</text></svg>';
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("static Mermaid rendering", () => {
	it("allows line breaks and local class colors but blocks resources and configuration before rendering", () => {
		expect(() => assertStaticMermaid('flowchart LR\n A("中文<br/>下一行") --> B\n classDef soft fill:#eee,stroke:#ccc')).not.toThrow();
		for (const source of [
			'flowchart LR\n A@{img: "https://evil.example/track"}',
			'flowchart LR\n A@{"img": "relative.png"}',
			'%%{init: {"securityLevel":"loose"}}%%\nflowchart LR\n A --> B',
			'---\nconfig:\n themeCSS: "@import x"\n---\nflowchart LR\n A --> B',
			'flowchart LR\n A["<img src=track.png>"]',
			'flowchart LR\n classDef x fill:url(https://evil.example/track)',
			'flowchart LR\n classDef x fill:u\\72l(track.png)',
		]) expect(() => assertStaticMermaid(source)).toThrow();
	});

	it("initializes strict security and leaves no render container behind", async () => {
		sdk.render.mockResolvedValue({ svg });
		const result = await renderMermaid("flowchart LR\n A --> B");
		expect(sdk.initialize).toHaveBeenCalledWith(expect.objectContaining({ securityLevel: "strict", htmlLabels: false, startOnLoad: false, suppressErrorRendering: true }));
		const config = sdk.initialize.mock.calls[0][0];
		expect(config.secure).toEqual(expect.arrayContaining(["securityLevel", "htmlLabels", "themeCSS", "themeVariables", "fontFamily", "secure", "dompurifyConfig"]));
		expect(result).toMatchObject({ width: 600, height: 400 });
		expect(document.querySelector('[aria-hidden="true"]')).toBeNull();
		sdk.render.mockRejectedValueOnce(new Error("parse"));
		await expect(renderMermaid("not a diagram")).rejects.toThrow("parse");
		expect(document.querySelector('[aria-hidden="true"]')).toBeNull();
		const before = sdk.render.mock.calls.length;
		await expect(renderMermaid('flowchart LR\n A@{img:"remote.png"}')).rejects.toThrow();
		expect(sdk.render).toHaveBeenCalledTimes(before);
	});

	it("removes active SVG content and remote references while preserving local arrow markers", () => {
		const result = sanitizeMermaidSvg(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 400" onload="bad()"><script>bad()</script><foreignObject>html</foreignObject><image href="https://evil.example/a"/><a href="javascript:bad()"><text>link</text></a><style>.x{fill:url(https://evil.example/a)}.y{marker-end:url(#arrow)}</style><path onmouseover="bad()" marker-end="url(#arrow)" style="fill:url(https://evil.example/a)"/><text>中文</text></svg>`);
		expect(result.svg).not.toMatch(/script|foreignObject|<image|onload|onmouseover|href=|https:|javascript:/);
		expect(result.svg).toContain("url(#arrow)");
		expect(result.svg).toContain("中文");
		expect(result.svg).toContain('width="600"');
		expect(() => sanitizeMermaidSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 Infinity 2"/>')).toThrow();
	});
});
