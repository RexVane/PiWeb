/**
 * pi 的眼睛：交给 pi 的浏览器工具（createAgentSession 的 customTools）。
 * 每个 pi 会话一个无头浏览器标签页；截图作为图片直接交给模型（模型看不了图时改为页面文本大纲），
 * 每次结果都附带本页加载以来的控制台错误，pi 改完界面能自己看效果、发现运行时问题。
 */
import { defineTool, type AgentToolResult, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { getBrowserTab, type BrowserTab, type ConsoleEntry, type Device, DEVICES } from "./manager";
import { checkBrowserUrl } from "./url-policy";

export const BROWSER_TOOL_NAMES = ["browser_open", "browser_screenshot", "browser_console", "browser_click", "browser_type"] as const;

export interface BrowserToolDetails {
	url: string;
	title: string;
	device: Device;
	errors: number;
	warnings: number;
}

type Result = AgentToolResult<BrowserToolDetails | undefined>;

const deviceSchema = Type.Optional(Type.Union([Type.Literal("desktop"), Type.Literal("tablet"), Type.Literal("mobile")], {
	description: "Viewport: desktop 1280×800 (default), tablet 768×1024, mobile 390×844",
}));

/** 模型看不了图时的页面描述：标题层级、可交互元素、可见文本（截断） */
const OUTLINE_SCRIPT = `(() => {
	const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
	const clean = (v) => String(v || "").replace(/\\s+/g, " ").trim().slice(0, 100);
	const headings = [...document.querySelectorAll("h1,h2,h3")].filter(visible).slice(0, 30).map((h) => h.tagName.toLowerCase() + ": " + clean(h.innerText));
	const controls = [...document.querySelectorAll("a[href],button,input,select,textarea,[role=button]")].filter(visible).slice(0, 60).map((el) => {
		const id = el.id ? " #" + el.id : "";
		const type = el.type && el.tagName !== "BUTTON" ? "[type=" + el.type + "]" : "";
		return "- " + el.tagName.toLowerCase() + type + id + ": " + clean(el.innerText || el.value || el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.getAttribute("name"));
	});
	const text = document.body ? document.body.innerText.replace(/\\n{3,}/g, "\\n\\n").trim().slice(0, 4000) : "";
	return ["Headings:", ...headings, "", "Interactive elements:", ...controls, "", "Visible text (truncated):", text].join("\\n");
})()`;

function canSeeImages(ctx: ExtensionContext | undefined): boolean {
	return Boolean(ctx?.model?.input?.includes("image"));
}

function aborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new Error("aborted");
}

function consoleSummary(entries: ConsoleEntry[]): { text: string; errors: number; warnings: number } {
	const errors = entries.filter((e) => e.level === "error");
	const warnings = entries.filter((e) => e.level === "warning");
	if (!errors.length && !warnings.length) return { text: "Console: no errors or warnings since the page loaded.", errors: 0, warnings: 0 };
	const lines = [...errors, ...warnings].slice(-5).map((e) => `  [${e.level}/${e.source}] ${e.text.slice(0, 300)}${e.url ? ` (${e.url})` : ""}`);
	return {
		text: [`Console: ${errors.length} error(s), ${warnings.length} warning(s) since the page loaded (latest ${lines.length}; use browser_console for all):`, ...lines].join("\n"),
		errors: errors.length,
		warnings: warnings.length,
	};
}

/** 看一眼当前页面：截图（或文本大纲）+ 控制台摘要 */
async function observe(tab: BrowserTab, ctx: ExtensionContext | undefined, shot: { fullPage?: boolean; selector?: string } = {}, note?: string): Promise<Result> {
	const info = await tab.info();
	const summary = consoleSummary(tab.console.filter((e) => e.ts >= tab.loadedAt));
	const view = DEVICES[tab.device];
	const header = [
		...(note ? [note] : []),
		`Page: ${info.title || "(untitled)"} — ${info.url}`,
		`Viewport: ${tab.device} ${view.width}×${view.height}`,
		summary.text,
	].join("\n");
	const details: BrowserToolDetails = { url: info.url, title: info.title, device: tab.device, errors: summary.errors, warnings: summary.warnings };
	if (canSeeImages(ctx)) {
		const image = await tab.screenshot(shot);
		return { content: [{ type: "text", text: header }, { type: "image", data: image.data, mimeType: "image/jpeg" }], details };
	}
	const outline = await tab.evaluate<string>(OUTLINE_SCRIPT);
	return { content: [{ type: "text", text: `${header}\n\n(The current model cannot view images; page outline instead.)\n${outline}` }], details };
}

async function openTab(sessionKey: string, signal: AbortSignal | undefined, requirePage = true): Promise<BrowserTab> {
	aborted(signal);
	const tab = await getBrowserTab(sessionKey);
	if (requirePage && !tab.hasPage) throw new Error("No page is open in the browser yet; call browser_open with a URL first.");
	return tab;
}

/** 每个 pi 会话一组：sessionKey 决定用哪个标签页 */
export function createBrowserTools(sessionKey: string): ToolDefinition[] {
	return [
		defineTool({
			name: "browser_open",
			label: "browser_open",
			description: "Open a web page in a headless browser and look at it: returns a screenshot of the viewport plus console errors / failed requests since the page loaded. Use it to check the web app you are working on, e.g. a dev server at http://localhost:5173. Each session has its own browser tab; only local and private-network URLs are allowed.",
			promptSnippet: "Open a local web page in a headless browser and look at it (screenshot + console errors)",
			promptGuidelines: [
				"After changing the UI of a web app whose dev server is running, open the page with browser_open (or refresh the view with browser_screenshot) and check the screenshot and console errors before reporting the change as done.",
			],
			parameters: Type.Object({
				url: Type.String({ description: "Page URL, e.g. http://localhost:5173/settings" }),
				device: deviceSchema,
			}),
			async execute(_id, { url, device }, signal, _onUpdate, ctx) {
				const target = await checkBrowserUrl(url);
				const tab = await openTab(sessionKey, signal, false);
				if (device && device !== tab.device) await tab.setDevice(device);
				aborted(signal);
				await tab.navigate(target.href);
				aborted(signal);
				return observe(tab, ctx);
			},
		}),
		defineTool({
			name: "browser_screenshot",
			label: "browser_screenshot",
			description: "Take a fresh look at the page currently open in the browser (after edits, hot reload or interactions). Optionally capture the full page, a single element, or switch the viewport size.",
			promptSnippet: "Look at the currently open page again (screenshot + console errors)",
			parameters: Type.Object({
				fullPage: Type.Optional(Type.Boolean({ description: "Capture the whole scrollable page instead of the viewport (up to 6000px tall)" })),
				selector: Type.Optional(Type.String({ description: "CSS selector of one element to capture" })),
				device: deviceSchema,
			}),
			async execute(_id, { fullPage, selector, device }, signal, _onUpdate, ctx) {
				const tab = await openTab(sessionKey, signal);
				if (device && device !== tab.device) await tab.setDevice(device);
				return observe(tab, ctx, { fullPage, selector });
			},
		}),
		defineTool({
			name: "browser_console",
			label: "browser_console",
			description: "List console errors / warnings, uncaught exceptions, failed requests and HTTP error responses recorded for the open page.",
			promptSnippet: "List console errors, exceptions and failed requests of the open page",
			parameters: Type.Object({
				level: Type.Optional(Type.Union([Type.Literal("error"), Type.Literal("all")], { description: "error (default) or all (errors and warnings)" })),
				sinceLoad: Type.Optional(Type.Boolean({ description: "Only entries since the page was last opened or reloaded (default true)" })),
			}),
			async execute(_id, { level, sinceLoad }, signal) {
				const tab = await openTab(sessionKey, signal);
				const from = sinceLoad === false ? 0 : tab.loadedAt;
				const entries = tab.console.filter((e) => e.ts >= from && (level === "all" || e.level === "error"));
				const info = await tab.info();
				const body = entries.length
					? entries.map((e) => `[${e.level}/${e.source}] ${e.text}${e.url ? ` (${e.url})` : ""}`).join("\n")
					: `No ${level === "all" ? "errors or warnings" : "errors"} recorded.`;
				const errors = entries.filter((e) => e.level === "error").length;
				return {
					content: [{ type: "text", text: `Page: ${info.title || "(untitled)"} — ${info.url}\n${body}` }],
					details: { url: info.url, title: info.title, device: tab.device, errors, warnings: entries.length - errors },
				};
			},
		}),
		defineTool({
			name: "browser_click",
			label: "browser_click",
			description: "Click an element of the open page (by CSS selector, or by viewport coordinates taken from the last screenshot), then return a new screenshot.",
			promptSnippet: "Click an element of the open page, then look at the result",
			parameters: Type.Object({
				selector: Type.Optional(Type.String({ description: "CSS selector of the element to click" })),
				x: Type.Optional(Type.Number({ description: "Viewport x coordinate (CSS pixels), when no selector is given" })),
				y: Type.Optional(Type.Number({ description: "Viewport y coordinate (CSS pixels), when no selector is given" })),
			}),
			async execute(_id, { selector, x, y }, signal, _onUpdate, ctx) {
				const tab = await openTab(sessionKey, signal);
				await tab.click({ selector, x, y });
				aborted(signal);
				return observe(tab, ctx);
			},
		}),
		defineTool({
			name: "browser_type",
			label: "browser_type",
			description: "Focus an input of the open page by CSS selector, type text into it (optionally press Enter), then return a new screenshot.",
			promptSnippet: "Type into an input of the open page, then look at the result",
			parameters: Type.Object({
				selector: Type.String({ description: "CSS selector of the input / textarea / contenteditable element" }),
				text: Type.String({ description: "Text to type" }),
				submit: Type.Optional(Type.Boolean({ description: "Press Enter after typing" })),
			}),
			async execute(_id, { selector, text, submit }, signal, _onUpdate, ctx) {
				const tab = await openTab(sessionKey, signal);
				await tab.type(selector, text, submit === true);
				aborted(signal);
				return observe(tab, ctx);
			},
		}),
	];
}
