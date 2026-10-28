import type { MermaidConfig } from "mermaid";

export interface MermaidImage {
	svg: string;
	width: number;
	height: number;
}

const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';
const config: MermaidConfig = {
	startOnLoad: false,
	securityLevel: "strict",
	suppressErrorRendering: true,
	htmlLabels: false,
	maxTextSize: 50_000,
	maxEdges: 500,
	theme: "base",
	look: "classic",
	layout: "dagre",
	fontFamily: FONT,
	altFontFamily: FONT,
	themeVariables: {
		fontFamily: FONT,
		fontSize: "16px",
		primaryColor: "#e7f2ff",
		primaryTextColor: "#25486c",
		primaryBorderColor: "#cbd5df",
		secondaryColor: "#eaf4f8",
		tertiaryColor: "#eef5ee",
		lineColor: "#8493a8",
		textColor: "#25486c",
		mainBkg: "#e7f2ff",
		nodeBorder: "#cbd5df",
		clusterBkg: "#f8fafc",
		clusterBorder: "#d9e1eb",
		edgeLabelBackground: "#ffffff",
		background: "#ffffff",
	},
	flowchart: { htmlLabels: false, useMaxWidth: false, curve: "basis", padding: 18, nodeSpacing: 40, rankSpacing: 58 },
	sequence: { useMaxWidth: false },
	themeCSS: ".node rect { rx: 12px; ry: 12px; } .cluster rect { rx: 16px; ry: 16px; } .flowchart-link { stroke-width: 1.25px; } .edgeLabel { font-size: 14px; }",
};
// Diagram directives/frontmatter must never relax the site security or load remote assets.
config.secure = [...Object.keys(config), "secure", "dompurifyConfig"];

let mermaidPromise: Promise<typeof import("mermaid")["default"]> | undefined;
let nextId = 0;

/** Strict Mermaid still loads image nodes before sanitizing its final SVG. Check before import/render. */
export function assertStaticMermaid(source: string): void {
	if (!source.trim() || source.length > 50_000) throw new Error("Diagram is empty or too large");
	if (
		/^\s*---(?:\r?\n|$)/.test(source) || /%%\s*\{/.test(source) ||
		/\b(?:img|image|icon)["']?\s*:/i.test(source) ||
		/\b(?:url|image-set)\s*\(|@import|\\/i.test(source) ||
		/<\/?(?!br\b)[a-z][^>]*>/i.test(source)
	) throw new Error("Only static diagrams without configuration, HTML or external resources are supported");
}

const SVG_ELEMENTS = new Set([
	"svg", "g", "defs", "marker", "path", "line", "polyline", "polygon", "rect", "circle", "ellipse",
	"text", "tspan", "textPath", "clipPath", "mask", "pattern", "linearGradient", "radialGradient", "stop", "title", "desc", "style",
]);

function staticCss(css: string): string {
	// Mermaid's own keyframes are harmless but unnecessary in a saved static image.
	if (/\\|@import|@font-face|image-set\s*\(/i.test(css)) return "";
	return css.replace(/url\(\s*(["']?)(.*?)\1\s*\)/gi, (_all, _quote, target: string) => /^#[\w:.-]+$/.test(target) ? `url(${target})` : "none")
		.replace(/animation(?:-[\w-]+)?\s*:[^;}]+;?/gi, "");
}

/** Keep a self-contained static image. Never insert it as HTML. */
export function sanitizeMermaidSvg(input: string): MermaidImage {
	const doc = new DOMParser().parseFromString(input, "image/svg+xml");
	const root = doc.documentElement;
	if (root.localName !== "svg" || doc.querySelector("parsererror")) throw new Error("Invalid SVG");
	for (const element of [...doc.querySelectorAll("*")]) {
		if (!SVG_ELEMENTS.has(element.localName) || element.namespaceURI !== "http://www.w3.org/2000/svg") {
			element.remove();
			continue;
		}
		for (const attribute of [...element.attributes]) {
			const name = attribute.localName.toLowerCase();
			if (name.startsWith("on") || name === "href" || name === "src" || name === "tabindex") element.removeAttributeNode(attribute);
			else if (name === "style") element.setAttribute("style", staticCss(attribute.value));
			else if (/url\s*\(/i.test(attribute.value)) element.setAttribute(attribute.name, staticCss(attribute.value));
		}
		if (element.localName === "style") element.textContent = staticCss(element.textContent ?? "");
	}
	const viewBox = root.getAttribute("viewBox")?.trim().split(/[\s,]+/).map(Number);
	const width = viewBox?.[2] ?? Number.parseFloat(root.getAttribute("width") ?? "");
	const height = viewBox?.[3] ?? Number.parseFloat(root.getAttribute("height") ?? "");
	if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || width > 30_000 || height > 30_000) throw new Error("Invalid SVG dimensions");
	root.setAttribute("xmlns", "http://www.w3.org/2000/svg");
	root.setAttribute("width", String(Math.ceil(width)));
	root.setAttribute("height", String(Math.ceil(height)));
	root.setAttribute("style", `background:#ffffff;font-family:${FONT}`);
	return { svg: new XMLSerializer().serializeToString(root), width: Math.ceil(width), height: Math.ceil(height) };
}

export async function renderMermaid(source: string): Promise<MermaidImage> {
	assertStaticMermaid(source);
	mermaidPromise ??= import("mermaid").then(({ default: mermaid }) => {
		mermaid.initialize(config);
		return mermaid;
	}).catch((error: unknown) => { mermaidPromise = undefined; throw error; });
	const mermaid = await mermaidPromise;
	await document.fonts?.ready;
	const container = document.createElement("div");
	container.setAttribute("aria-hidden", "true");
	container.style.cssText = "position:fixed;left:-100000px;top:0;visibility:hidden;pointer-events:none";
	document.body.appendChild(container);
	try {
		const { svg } = await mermaid.render(`pw-mermaid-${++nextId}`, source, container);
		return sanitizeMermaidSvg(svg);
	} finally {
		container.remove();
	}
}

export function mermaidImageUrl(image: MermaidImage): string {
	return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(image.svg)}`;
}
