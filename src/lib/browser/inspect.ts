/**
 * 截图上点选元素（B3）：在 pi 的标签页里取视口某一点的元素，读出定位源码要用的线索。
 * 逻辑移植自 iframe 方案的接入脚本（文本 / DOM 路径 / 构建期源码属性），另加框架开发态元数据：
 * React ≤18 的 fiber._debugSource、Vue 组件实例的 __file、Svelte 的 __svelte_meta.loc。
 * 页面里读出的一切都按不可信数据处理：服务端截断长度，路径交给 locateSource 做工作区边界校验。
 */
import { COMPONENT_FILE_KEY } from "./source-hint-keys";

export interface ElementSourceHint {
	framework: "react" | "vue" | "svelte";
	file: string;
	/** 1 起始；Vue 只到文件 */
	line?: number;
	column?: number;
	component?: string;
}

export interface ElementBox {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface PickedElementInfo {
	tag: string;
	id?: string;
	/** 元素自身的可见文本（截断） */
	text: string;
	/** 形如 main > div.card > button.save */
	domPath: string;
	/** 构建期源码属性（向上 6 层收集） */
	attrs: Record<string, string>;
	hints: ElementSourceHint[];
	/** 视口坐标（CSS 像素） */
	box: ElementBox;
	/** 页面滚动位置：裁剪截图要换算成文档坐标 */
	scroll: { x: number; y: number };
	pageUrl: string;
	title: string;
}

/** 与 dev-inspect-service 的 SOURCE_ATTR_KEYS 一致：构建期注入的源码位置属性 */
const SOURCE_ATTR_KEYS = ["data-source", "data-insp-path", "data-source-loc", "data-source-location", "data-loc"];

const LIMITS = { text: 200, domPath: 300, attr: 500, file: 1000, component: 100, url: 2000, title: 200 };

/** 在页面里执行的表达式：坐标只接受有限数字，序列化后嵌入，不拼接任何来自用户的字符串 */
export function elementAtPointScript(x: number, y: number): string {
	if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("invalid point");
	return `(() => {
	const X = ${JSON.stringify(x)}, Y = ${JSON.stringify(y)};
	let el = document.elementFromPoint(X, Y);
	for (let i = 0; el && el.shadowRoot && i < 10; i += 1) {
		const inner = el.shadowRoot.elementFromPoint(X, Y);
		if (!inner || inner === el) break;
		el = inner;
	}
	if (!el || el.nodeType !== 1) return null;
	const SOURCE_ATTR_KEYS = ${JSON.stringify(SOURCE_ATTR_KEYS)};
	const clean = (v, n) => String(v == null ? "" : v).replace(/\\s+/g, " ").trim().slice(0, n);
	const attrs = {};
	for (let node = el, depth = 0; node && node.nodeType === 1 && depth < 6; node = node.parentElement, depth += 1) {
		for (const key of SOURCE_ATTR_KEYS) {
			if (attrs[key]) continue;
			const value = node.getAttribute && node.getAttribute(key);
			if (value) attrs[key] = value;
		}
	}
	const bestText = (node) => {
		const direct = [];
		for (const child of node.childNodes) if (child.nodeType === 3 && child.nodeValue && child.nodeValue.trim()) direct.push(child.nodeValue.trim());
		const value = direct.join(" ") || node.innerText || node.textContent || node.getAttribute("aria-label") || node.getAttribute("placeholder") || node.getAttribute("alt") || node.getAttribute("title") || node.value || "";
		return clean(value, 200);
	};
	const domPath = (node) => {
		const parts = [];
		for (let depth = 0; node && node.nodeType === 1 && depth < 6; node = node.parentElement, depth += 1) {
			let seg = node.tagName.toLowerCase();
			if (node.id) { parts.unshift(seg + "#" + node.id); break; }
			if (node.classList && node.classList.length) seg += "." + Array.from(node.classList).slice(0, 3).join(".");
			parts.unshift(seg.slice(0, 80));
		}
		return parts.join(" > ").slice(0, 300);
	};
	const hints = [];
	// React ≤18（开发构建）：元素的 fiber 记着 JSX 写在哪（_debugSource）；React 19 去掉了它
	const react = () => {
		for (let node = el, d = 0; node && d < 15; node = node.parentElement, d += 1) {
			const key = Object.keys(node).find((k) => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$"));
			if (!key) continue;
			for (let fiber = node[key], i = 0; fiber && i < 40; fiber = fiber.return, i += 1) {
				const src = fiber._debugSource;
				if (!src || !src.fileName) continue;
				let component;
				for (let f = fiber, j = 0; f && j < 40; f = f.return, j += 1) {
					const t = f.type;
					if (typeof t === "function") { component = t.displayName || t.name; break; }
					if (t && typeof t === "object" && (t.displayName || (t.render && (t.render.displayName || t.render.name)))) { component = t.displayName || t.render.displayName || t.render.name; break; }
				}
				return { framework: "react", file: String(src.fileName), line: Number(src.lineNumber) || undefined, column: Number(src.columnNumber) || undefined, component };
			}
			return null;
		}
		return null;
	};
	// Vue 3：__vueParentComponent；Vue 2：__vue__。开发构建的组件选项带 __file（只到文件）
	const vue = () => {
		for (let node = el, d = 0; node && d < 15; node = node.parentElement, d += 1) {
			const inst = node.__vueParentComponent;
			if (inst) {
				for (let c = inst, i = 0; c && i < 20; c = c.parent, i += 1) {
					const t = c.type || {};
					if (t.__file) return { framework: "vue", file: String(t.__file), component: t.name || t.__name };
				}
				return null;
			}
			const vm = node.__vue__;
			if (vm) {
				for (let c = vm, i = 0; c && i < 20; c = c.$parent, i += 1) {
					const o = c.$options || {};
					if (o.__file) return { framework: "vue", file: String(o.__file), component: o.name };
				}
				return null;
			}
		}
		return null;
	};
	// Svelte（开发构建）：__svelte_meta.loc。Svelte 4 的行号从 0 起（带 char），Svelte 5 从 1 起
	const svelte = () => {
		for (let node = el, d = 0; node && d < 15; node = node.parentElement, d += 1) {
			const meta = node.__svelte_meta;
			const loc = meta && meta.loc;
			if (!loc || !loc.file) continue;
			const zeroBased = Object.prototype.hasOwnProperty.call(loc, "char");
			return {
				framework: "svelte",
				file: String(loc.file),
				line: typeof loc.line === "number" ? loc.line + (zeroBased ? 1 : 0) : undefined,
				column: typeof loc.column === "number" ? loc.column + 1 : undefined,
			};
		}
		return null;
	};
	for (const read of [react, vue, svelte]) {
		try { const hint = read(); if (hint) hints.push(hint); } catch (e) { /* 页面对象可能是代理或被冻结 */ }
	}
	const r = el.getBoundingClientRect();
	return {
		tag: el.tagName.toLowerCase(),
		id: el.id || undefined,
		text: bestText(el),
		domPath: domPath(el),
		attrs,
		hints,
		box: { x: r.left, y: r.top, width: r.width, height: r.height },
		scroll: { x: window.scrollX, y: window.scrollY },
		pageUrl: location.href,
		title: document.title,
	};
})()`;
}

function str(value: unknown, max: number): string {
	return typeof value === "string" ? value.slice(0, max) : "";
}

function num(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function positiveInt(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** 页面返回值的形状与长度校验：页面脚本可被页面自身篡改，不能信任 */
export function sanitizePickedElement(raw: unknown): PickedElementInfo | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Record<string, any>;
	const tag = str(r.tag, 40).toLowerCase();
	if (!/^[a-z][a-z0-9-]*$/.test(tag)) return null;
	const attrs: Record<string, string> = {};
	for (const key of SOURCE_ATTR_KEYS) {
		const value = str(r.attrs?.[key], LIMITS.attr);
		if (value) attrs[key] = value;
	}
	const hints: ElementSourceHint[] = [];
	for (const h of Array.isArray(r.hints) ? r.hints.slice(0, 3) : []) {
		if (!h || (h.framework !== "react" && h.framework !== "vue" && h.framework !== "svelte")) continue;
		const file = str(h.file, LIMITS.file).trim();
		if (!file) continue;
		hints.push({
			framework: h.framework,
			file,
			line: positiveInt(h.line),
			column: positiveInt(h.column),
			component: str(h.component, LIMITS.component) || undefined,
		});
	}
	return {
		tag,
		id: str(r.id, 100) || undefined,
		text: str(r.text, LIMITS.text),
		domPath: str(r.domPath, LIMITS.domPath),
		attrs,
		hints,
		box: { x: num(r.box?.x), y: num(r.box?.y), width: Math.max(0, num(r.box?.width)), height: Math.max(0, num(r.box?.height)) },
		scroll: { x: num(r.scroll?.x), y: num(r.scroll?.y) },
		pageUrl: str(r.pageUrl, LIMITS.url),
		title: str(r.title, LIMITS.title),
	};
}

/** 框架线索 → locateSource 认识的键（react-source / svelte-source 精确到行，vue-file 只到文件） */
export function locateAttrsFromHints(hints: ElementSourceHint[]): Record<string, string> {
	const out: Record<string, string> = {};
	for (const hint of hints) {
		if (hint.framework === "vue") {
			out[COMPONENT_FILE_KEY] ??= hint.file;
			continue;
		}
		const key = hint.framework === "react" ? "react-source" : "svelte-source";
		out[key] ??= `${hint.file}${hint.line ? `:${hint.line}${hint.column ? `:${hint.column}` : ""}` : ""}`;
	}
	return out;
}

/** 元素在截图上的简短称呼：<button> “保存” */
export function elementLabel(info: Pick<PickedElementInfo, "tag" | "text" | "id">): string {
	const text = info.text.length > 40 ? `${info.text.slice(0, 39)}…` : info.text;
	return `<${info.tag}${info.id ? `#${info.id}` : ""}>${text ? ` “${text}”` : ""}`;
}
