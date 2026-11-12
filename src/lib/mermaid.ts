import type { MermaidConfig } from "mermaid";

export interface MermaidImage {
	svg: string;
	width: number;
	height: number;
}

const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';

function isDarkTheme(): boolean {
	if (typeof document === "undefined") return true;
	return document.documentElement.hasAttribute("data-ds-dark-theme") || Boolean(document.body?.hasAttribute("data-ds-dark-theme"));
}

function buildMermaidConfig(dark: boolean): MermaidConfig {
	const cfg: MermaidConfig = {
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
		themeVariables: dark
			? {
				fontFamily: FONT,
				fontSize: "14px",
				primaryColor: "#1b2838",
				primaryTextColor: "#e2e8f0",
				primaryBorderColor: "#3b4f6b",
				secondaryColor: "#1e293b",
				tertiaryColor: "#172033",
				lineColor: "#64748b",
				textColor: "#e2e8f0",
				mainBkg: "#1b2838",
				nodeBorder: "#3b4f6b",
				clusterBkg: "#111827",
				clusterBorder: "#283548",
				edgeLabelBackground: "#161f2e",
				background: "transparent",
			}
			: {
				fontFamily: FONT,
				fontSize: "14px",
				primaryColor: "#eff6ff",
				primaryTextColor: "#1e293b",
				primaryBorderColor: "#93c5fd",
				secondaryColor: "#f1f5f9",
				tertiaryColor: "#f8fafc",
				lineColor: "#64748b",
				textColor: "#1e293b",
				mainBkg: "#eff6ff",
				nodeBorder: "#93c5fd",
				clusterBkg: "#f8fafc",
				clusterBorder: "#cbd5e1",
				edgeLabelBackground: "#ffffff",
				background: "transparent",
			},
		flowchart: { htmlLabels: false, useMaxWidth: false, curve: "basis", padding: 14, nodeSpacing: 34, rankSpacing: 44 },
		sequence: { useMaxWidth: false },
		themeCSS: ".node rect { rx: 10px; ry: 10px; } .cluster rect { rx: 14px; ry: 14px; } .flowchart-link { stroke-width: 1.35px; } .edgeLabel { font-size: 13px; }",
	};
	// Diagram directives/frontmatter must never relax the site security or load remote assets.
	cfg.secure = [...Object.keys(cfg), "secure", "dompurifyConfig"];
	return cfg;
}

let mermaidPromise: Promise<typeof import("mermaid")["default"]> | undefined;
let lastThemeDark: boolean | undefined;
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
	root.setAttribute("style", `background:transparent;font-family:${FONT}`);
	return { svg: new XMLSerializer().serializeToString(root), width: Math.ceil(width), height: Math.ceil(height) };
}

export async function renderMermaid(source: string): Promise<MermaidImage> {
	assertStaticMermaid(source);
	const dark = isDarkTheme();
	mermaidPromise ??= import("mermaid").then(({ default: mermaid }) => {
		lastThemeDark = dark;
		mermaid.initialize(buildMermaidConfig(dark));
		return mermaid;
	}).catch((error: unknown) => { mermaidPromise = undefined; throw error; });
	const mermaid = await mermaidPromise;
	if (lastThemeDark !== dark) {
		lastThemeDark = dark;
		mermaid.initialize(buildMermaidConfig(dark));
	}
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
