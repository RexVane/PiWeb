/**
 * extension-ui：把 pi 扩展的界面请求桥接到浏览器——与 pi 自己的 RPC 模式
 * （extension_ui_request / extension_ui_response）同一套语义、同一份支持清单：
 * 对话框 select / confirm / input / editor 等应答，notify / setStatus / setWidget / setTitle /
 * setEditorText 只通知。其余依赖真实终端的能力（custom、setFooter、自定义编辑器…）与 RPC 模式一样是 no-op。
 * 没有页面在看时（无订阅者）select/input/editor 返回 undefined、confirm 返回 false，与 pi 的 noOp 行为一致。
 */
import { randomUUID } from "node:crypto";
import type { WebEvent, WebExtensionWidget, WebUiNode, WebUiResult, WebUiTone } from "./types";
import type { JsonValue, ResourceUiApi, ResourceUiOutcome, WebResourceView } from "./resources/protocol";

type UiMethod = Extract<WebEvent, { type: "extension_ui" }>["method"];
type UiEvent = Extract<WebEvent, { type: "extension_ui" }>;

interface PendingUi {
	request: UiEvent;
	resolve: (response: { value?: string; confirmed?: boolean; cancelled?: boolean }) => void;
	timer?: ReturnType<typeof setTimeout>;
	removeAbortListener?: () => void;
}

export interface ExtensionUiBridge {
	/** 供 AgentSession.bindExtensions 的 uiContext（只实现 Web 能承接的部分，其余 no-op） */
	uiContext: Record<string, unknown>;
	/** 浏览器应答 */
	respond(requestId: string, response: { value?: string; confirmed?: boolean; cancelled?: boolean }): boolean;
	/** 当前仍待应答的请求，不含已答/取消/过期请求。 */
	getPendingRequests(): UiEvent[];
	/** 会话销毁：把挂起的对话框全部按取消结束 */
	dispose(): void;
	cancelPending(): void;
	/** Cancel requests whose owning resource is no longer enabled. */
	reconcileResources(views: WebResourceView[]): void;
	/** Clear old-runtime decorations before new extensions receive session_start. */
	resetDecorations(): void;
	/** 扩展通过 setStatus 设的状态文本（页脚展示） */
	statuses: Map<string, string>;
	/** 扩展通过 setWidget 设的文字块（输入框上方 / 下方） */
	widgets: Map<string, WebExtensionWidget>;
	/** 扩展通过 setTitle 设的窗口标题 */
	getTitle(): string | undefined;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
/** 单个 widget 的上限：扩展把整份日志塞进来时不能撑爆快照和 SSE 帧 */
const WIDGET_MAX_LINES = 200;
const WIDGET_MAX_LINE_CHARS = 2_000;

// ---------- JSON UI 桥：扩展送树，网页渲染 ----------

/** 树深、节点数、单段文本、列表项、表格规模的上限：扩展给的东西一律当不可信输入 */
const WEB_UI_MAX_DEPTH = 10;
const WEB_UI_MAX_NODES = 400;
const WEB_UI_MAX_TEXT = 4_000;
const WEB_UI_MAX_CHILDREN = 60;
const WEB_UI_MAX_ITEMS = 200;
const WEB_UI_MAX_TABLE_ROWS = 200;
const WEB_UI_MAX_TABLE_COLS = 12;
/** 没适配的扩展：终端组件渲染出来的行数上限 */
const WEB_UI_FALLBACK_LINES = 200;

const plainText = (text: unknown): string => (typeof text === "string" ? text : String(text ?? ""));
/** 扩展自己用 chalk 之类上的色：Web 不渲染 ANSI，原样显示就是一串乱码，去掉转义序列只留文字 */
const ANSI_SEQUENCE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const displayText = (text: unknown): string => plainText(text).replace(ANSI_SEQUENCE, "");
/**
 * 扩展常写 `ctx.ui.theme.fg("accent", text)` 给状态文字上色；pi 的 noOp 上下文也带 theme。
 * 缺了它扩展一调就抛 TypeError。Web 不渲染 ANSI，所以给一个原样返回文字、不加任何转义序列的主题。
 */
const PLAIN_THEME = {
	name: "piweb-plain",
	style: (text: string) => plainText(text),
	fg: (_color: string, text: string) => plainText(text),
	bg: (_color: string, text: string) => plainText(text),
	bold: plainText,
	italic: plainText,
	underline: plainText,
	inverse: plainText,
	strikethrough: plainText,
	getFgAnsi: () => "",
	getBgAnsi: () => "",
	getColorMode: () => "truecolor",
	getThinkingBorderColor: () => plainText,
	getBashModeBorderColor: () => plainText,
};

const TONES = new Set(["default", "muted", "accent", "success", "warning", "danger"]);
const NODE_TYPES = new Set(["box", "text", "list", "table", "progress", "code", "form"]);

const clipText = (value: unknown, max = WEB_UI_MAX_TEXT): string => displayText(value).slice(0, max);
const clampInt = (value: unknown, min: number, max: number, fallback: number): number => {
	const num = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback;
	return Math.min(max, Math.max(min, num));
};

interface UiBudget {
	nodes: number;
}

/**
 * 扩展给的树一律当不可信输入：只放行白名单节点，超深/超宽/超长一律截断或丢弃。
 * 丢弃而不是抛错——扩展写错了不该让整个会话崩掉。
 */
function sanitizeUiNode(input: unknown, depth: number, budget: UiBudget): WebUiNode | undefined {
	if (!input || typeof input !== "object") return undefined;
	if (depth >= WEB_UI_MAX_DEPTH || budget.nodes >= WEB_UI_MAX_NODES) return undefined;
	const raw = input as Record<string, unknown>;
	const type = typeof raw.type === "string" ? raw.type : "";
	if (!NODE_TYPES.has(type)) return undefined;
	budget.nodes += 1;

	switch (type) {
		case "box": {
			const children = Array.isArray(raw.children)
				? (raw.children.slice(0, WEB_UI_MAX_CHILDREN).map((child) => sanitizeUiNode(child, depth + 1, budget)).filter(Boolean) as WebUiNode[])
				: [];
			return { type: "box", direction: raw.direction === "row" ? "row" : "column", gap: clampInt(raw.gap, 0, 24, 8), children };
		}
		case "text": {
			const tone = typeof raw.tone === "string" && TONES.has(raw.tone) ? (raw.tone as WebUiTone) : undefined;
			return { type: "text", text: clipText(raw.text), ...(tone ? { tone } : {}), ...(raw.mono === true ? { mono: true } : {}) };
		}
		case "list": {
			const items = Array.isArray(raw.items)
				? raw.items.slice(0, WEB_UI_MAX_ITEMS).map((item) => {
					const entry = (item ?? {}) as Record<string, unknown>;
					return {
						label: clipText(entry.label, 400),
						...(typeof entry.description === "string" ? { description: clipText(entry.description, 800) } : {}),
						...(typeof entry.action === "string" ? { action: clipText(entry.action, 400) } : {}),
						...(entry.disabled === true ? { disabled: true } : {}),
					};
				}).filter((item) => item.label.length > 0)
				: [];
			const selected = typeof raw.selected === "number" && Number.isFinite(raw.selected) ? clampInt(raw.selected, 0, Math.max(0, items.length - 1), 0) : undefined;
			return { type: "list", items, ...(selected !== undefined ? { selected } : {}) };
		}
		case "table": {
			const columns = Array.isArray(raw.columns) ? raw.columns.slice(0, WEB_UI_MAX_TABLE_COLS).map((column) => clipText(column, 120)) : [];
			const rows = Array.isArray(raw.rows)
				? raw.rows.slice(0, WEB_UI_MAX_TABLE_ROWS).map((row) => (Array.isArray(row) ? row.slice(0, columns.length || WEB_UI_MAX_TABLE_COLS).map((cell) => clipText(cell, 400)) : []))
				: [];
			return { type: "table", columns, rows };
		}
		case "progress": {
			const value = typeof raw.value === "number" && Number.isFinite(raw.value) ? Math.min(1, Math.max(0, raw.value)) : 0;
			return { type: "progress", value, ...(typeof raw.label === "string" ? { label: clipText(raw.label, 200) } : {}) };
		}
		case "code":
			return { type: "code", text: clipText(raw.text, 8_000), ...(typeof raw.language === "string" ? { language: clipText(raw.language, 40) } : {}) };
		case "form": {
			const fields = Array.isArray(raw.fields)
				? raw.fields.slice(0, 20).map((field) => {
					const entry = (field ?? {}) as Record<string, unknown>;
					const kind: "input" | "select" | "confirm" = entry.kind === "select" || entry.kind === "confirm" ? entry.kind : "input";
					const options = Array.isArray(entry.options) ? entry.options.slice(0, 60).map((option) => clipText(option, 200)) : undefined;
					return {
						kind,
						name: clipText(entry.name, 80),
						label: clipText(entry.label, 200),
						...(typeof entry.placeholder === "string" ? { placeholder: clipText(entry.placeholder, 200) } : {}),
						...(typeof entry.value === "string" ? { value: clipText(entry.value, 400) } : {}),
						...(kind === "select" && options ? { options } : {}),
					};
				}).filter((field) => field.name && field.label)
				: [];
			return { type: "form", fields, ...(typeof raw.submitLabel === "string" ? { submitLabel: clipText(raw.submitLabel, 80) } : {}) };
		}
		default:
			return undefined;
	}
}

/** 校验并裁剪一棵扩展 UI 树；返回 undefined 表示这不是一棵可渲染的树 */
export function sanitizeUiTree(input: unknown): WebUiNode | undefined {
	if (!input || typeof input !== "object") return undefined;
	return sanitizeUiNode(input, 0, { nodes: 0 });
}

/** 扩展是不是给了 PiWeb 的树（用来和"终端组件"区分） */
export function isUiTree(input: unknown): boolean {
	if (!input || typeof input !== "object") return false;
	const type = (input as { type?: unknown }).type;
	return typeof type === "string" && NODE_TYPES.has(type);
}

/** 终端组件（render(width)）→ 只读文本行：没适配的扩展至少还能看见内容 */
async function terminalComponentLines(component: unknown, width = 80): Promise<string[] | null> {
	let instance = component;
	if (typeof instance === "function") {
		try {
			// pi 的 custom(factory) 会拿到 (tui, theme, keybindings, done)；兜底渲染只给前两个真值，
			// 后两个给空壳，让只用 render() 的组件也能画出来（需要 done() 的交互式组件本来就不适用兜底）。
			instance = await (instance as (...args: unknown[]) => unknown)(
				{ requestRender: () => {}, invalidate: () => {}, stop: () => {} },
				PLAIN_THEME,
				{},
				() => {},
			);
		} catch {
			return null;
		}
	}
	const render = (instance as { render?: unknown } | null)?.render;
	if (typeof render !== "function") return null;
	try {
		const lines = (render as (w: number) => unknown).call(instance, width);
		if (!Array.isArray(lines)) return null;
		return lines.slice(0, WEB_UI_FALLBACK_LINES).map((line) => clipText(line));
	} catch {
		return null;
	}
}

export function createExtensionUiBridge(opts: {	publish: (evt: WebEvent) => void;
	hasViewers: () => boolean;
	isHeadless?: () => boolean;
	resources?: {
		resolve(resourceId: string, viewId: string): Promise<WebResourceView | undefined>;
		invoke(resourceId: string, action: string, args: JsonValue): Promise<JsonValue>;
	};
}): ExtensionUiBridge {
	const pending = new Map<string, PendingUi>();
	const statuses = new Map<string, string>();
	const widgets = new Map<string, WebExtensionWidget>();
	let title: string | undefined;
	let disposed = false;

	const ask = <T,>(
		request: Omit<UiEvent, "type" | "id" | "ts">,
		dialogOpts: { signal?: AbortSignal; timeout?: number; waitForViewer?: boolean } | undefined,
		fallback: T,
		parse: (r: { value?: string; confirmed?: boolean; cancelled?: boolean }) => T,
	): Promise<T> => {
		// No viewer: basic Pi calls keep their fallback semantics; explicitly viewer-waiting requests are retained.
		if (opts.isHeadless?.()) { opts.publish({ type: "interaction_unavailable", method: request.method, reason: "headless", ts: Date.now() }); return Promise.resolve(fallback); }
		if (disposed || dialogOpts?.signal?.aborted || (!opts.hasViewers() && !dialogOpts?.waitForViewer)) return Promise.resolve(fallback);
		const id = randomUUID();
		return new Promise<T>((resolve) => {
			const finish = (r: { value?: string; confirmed?: boolean; cancelled?: boolean } | null) => {
				const entry = pending.get(id);
				if (!entry) return;
				pending.delete(id);
				if (entry.timer) clearTimeout(entry.timer);
				entry.removeAbortListener?.();
				opts.publish({ type: "extension_ui_resolved", id, ts: Date.now() });
				resolve(r ? parse(r) : fallback);
			};
			const event: UiEvent = { type: "extension_ui", id, ...request, timeout: dialogOpts?.timeout, ts: Date.now() };
			const entry: PendingUi = { request: event, resolve: (r) => finish(r) };
			const timeout = dialogOpts?.timeout ?? DEFAULT_TIMEOUT_MS;
			entry.timer = setTimeout(() => finish(null), timeout);
			entry.timer.unref?.();
			const onAbort = () => finish(null);
			dialogOpts?.signal?.addEventListener("abort", onAbort, { once: true });
			entry.removeAbortListener = () => dialogOpts?.signal?.removeEventListener("abort", onAbort);
			pending.set(id, entry);
			opts.publish(event);
		});
	};

	/**
	 * PiWeb 专有：扩展直接给一棵界面树，浏览器用自己的组件渲染（不是把终端画面贴进网页）。
	 * 与 select/confirm 一样走 ask()：等用户答复，答复 JSON 解析成 { action, name, values }。
	 */
	const web = (
		tree: unknown,
		o?: { title?: string; signal?: AbortSignal; timeout?: number; text?: string },
	): Promise<WebUiResult | undefined> => {
		const safeTree = sanitizeUiTree(tree);
		const fallbackText = typeof o?.text === "string" ? o.text.slice(0, WEB_UI_MAX_TEXT) : undefined;
		if (!safeTree && !fallbackText) return Promise.resolve(undefined);
		return ask<WebUiResult | undefined>(
			{
				method: "web",
				title: typeof o?.title === "string" ? displayText(o.title).slice(0, 200) : undefined,
				...(safeTree ? { tree: safeTree } : {}),
				...(fallbackText ? { webText: fallbackText } : {}),
			},
			{ ...o, waitForViewer: true },
			undefined,
			(r) => {
				if (r.cancelled) return undefined;
				const raw = typeof r.value === "string" ? r.value : "";
				if (!raw) return undefined;
				try {
					const parsed = JSON.parse(raw) as WebUiResult;
					return parsed && typeof parsed === "object" ? parsed : { action: raw };
				} catch {
					return { action: raw };
				}
			},
		);
	};

	const resourceUi: ResourceUiApi = {
		apiVersion: 1,
		async request(resourceId, viewId, data, options) {
			if (disposed || options?.signal?.aborted || !opts.resources) return { status: "unavailable" };
			if (opts.isHeadless?.()) {
				opts.publish({ type: "interaction_unavailable", method: "resource", reason: "headless", ts: Date.now() });
				return { status: "unavailable" };
			}
			let safeData: JsonValue;
			try {
				const json = JSON.stringify(data ?? null);
				if (json.length > 128 * 1024) return { status: "unavailable" };
				safeData = JSON.parse(json);
			} catch { return { status: "unavailable" }; }
			const view = await opts.resources.resolve(resourceId, viewId);
			if (!view || disposed || options?.signal?.aborted) return { status: "unavailable" };
			const timeout = options?.timeout ?? DEFAULT_TIMEOUT_MS;
			if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 24 * 60 * 60_000) throw new Error("Invalid resource dialog timeout");
			const outcome = await ask<ResourceUiOutcome>({ method: "resource", title: options?.title?.slice(0, 200) || view.title, resourceView: view, resourceData: safeData },
				{ ...options, timeout, waitForViewer: true }, { status: "timeout" }, (response) => {
					if (response.cancelled || typeof response.value !== "string" || response.value.length > 128 * 1024) return { status: "cancelled" };
					try { return { status: "answered", value: JSON.parse(response.value) as JsonValue }; } catch { return { status: "cancelled" }; }
				});
			return outcome.status === "timeout" && options?.signal?.aborted ? { status: "cancelled" } : outcome;
		},
		async invoke(resourceId, action, args) {
			if (disposed || !opts.resources) throw new Error("Resource API unavailable");
			return opts.resources.invoke(resourceId, action, args ?? null);
		},
	};

	const uiContext: Record<string, unknown> = {
		resources: resourceUi,
		select: (title: string, options: string[], o?: { signal?: AbortSignal; timeout?: number }) =>
			ask<string | undefined>({ method: "select", title, options }, { ...o, waitForViewer: true }, undefined, (r) => (r.cancelled || !options.includes(r.value ?? "") ? undefined : r.value)),
		confirm: (title: string, message: string, o?: { signal?: AbortSignal; timeout?: number }) =>
			ask<boolean>({ method: "confirm", title, message }, o, false, (r) => (r.cancelled ? false : r.confirmed === true)),
		input: (title: string, placeholder?: string, o?: { signal?: AbortSignal; timeout?: number }) =>
			ask<string | undefined>({ method: "input", title, placeholder }, o, undefined, (r) => (r.cancelled ? undefined : r.value)),
		editor: (title: string, prefill?: string, o?: { signal?: AbortSignal; timeout?: number }) =>
			ask<string | undefined>({ method: "editor", title, prefill: typeof prefill === "string" ? prefill : undefined }, o, undefined, (r) => (r.cancelled ? undefined : r.value)),
		notify: (message: string, type?: "info" | "warning" | "error") => {
			opts.publish({ type: "extension_ui", id: randomUUID(), method: "notify", message, notifyType: type ?? "info", ts: Date.now() });
		},
		setStatus: (key: string, text: string | undefined) => {
			const shown = text === undefined || text === "" ? undefined : displayText(text);
			if (shown === undefined) statuses.delete(key);
			else statuses.set(key, shown);
			opts.publish({ type: "extension_ui", id: randomUUID(), method: "setStatus", statusKey: key, statusText: shown, ts: Date.now() });
		},
		setWorkingMessage: (message?: string) => {
			opts.publish({ type: "extension_ui", id: randomUUID(), method: "setWorkingMessage", message, ts: Date.now() });
		},
		/**
		 * 与 RPC 模式一致：只接字符串数组，组件工厂（需要真实终端来渲染）忽略。
		 * 忽略时不清掉同 key 的旧内容——扩展先发文字、再想升级成组件时，文字版仍是能看的那一个。
		 */
		setWidget: (key: string, content: unknown, options?: { placement?: string }) => {
			if (typeof key !== "string" || !key) return;
			if (content !== undefined && !Array.isArray(content)) return;
			const placement = options?.placement === "belowEditor" ? "belowEditor" : "aboveEditor";
			if (content === undefined) {
				if (!widgets.delete(key)) return;
				opts.publish({ type: "extension_ui", id: randomUUID(), method: "setWidget", widgetKey: key, ts: Date.now() });
				return;
			}
			const lines = content.slice(0, WIDGET_MAX_LINES).map((line) => displayText(line).slice(0, WIDGET_MAX_LINE_CHARS));
			widgets.set(key, { lines, placement });
			opts.publish({ type: "extension_ui", id: randomUUID(), method: "setWidget", widgetKey: key, widgetLines: lines, widgetPlacement: placement, ts: Date.now() });
		},
		setTitle: (value: string) => {
			const shown = displayText(value).trim();
			title = shown ? shown.slice(0, 200) : undefined;
			opts.publish({ type: "extension_ui", id: randomUUID(), method: "setTitle", title: title ?? "", ts: Date.now() });
		},
		setEditorText: (text: string) => {
			opts.publish({ type: "extension_ui", id: randomUUID(), method: "setEditorText", text: plainText(text), ts: Date.now() });
		},
		// RPC 模式同款：没有终端粘贴处理，直接当成设置输入框文字
		pasteToEditor: (text: string) => {
			opts.publish({ type: "extension_ui", id: randomUUID(), method: "setEditorText", text: plainText(text), ts: Date.now() });
		},
		// 终端专属能力：Web 无对应物，按 pi 的 noOp 处理
		onTerminalInput: () => () => {},
		setWorkingVisible: () => {},
		setWorkingIndicator: () => {},
		setHiddenThinkingLabel: () => {},
		setFooter: () => {},
		setHeader: () => {},
		// PiWeb 专有的网页 UI 入口
		web,
		/**
		 * 终端组件（custom）：PiWeb 优先认"界面树"；给的是终端组件就渲染成只读文本，
		 * 至少让没适配的扩展还能显示内容，而不是像以前那样完全消失。
		 */
		custom: async (component: unknown, o?: { title?: string; signal?: AbortSignal; timeout?: number }) => {
			if (isUiTree(component)) return web(component, o);
			const lines = await terminalComponentLines(component);
			if (!lines || lines.length === 0) return undefined;
			return web({ type: "code", text: lines.join("\n") }, { ...o, text: lines.join("\n") });
		},
		// 输入框的内容在浏览器里，服务端同步读不到（RPC 模式同样返回空串）
		getEditorText: () => "",
		addAutocompleteProvider: () => {},
		setEditorComponent: () => {},
		getEditorComponent: () => undefined,
		theme: PLAIN_THEME,
		getAllThemes: () => [],
		getTheme: () => undefined,
		// 与 pi 的 noOp 同一返回形状：扩展会读 result.success，返回 undefined 会让它们解构时出错
		setTheme: () => ({ success: false, error: "UI not available" }),
		getToolsExpanded: () => false,
		setToolsExpanded: () => {},
	};

	return {
		uiContext,
		statuses,
		widgets,
		getTitle: () => title,
		getPendingRequests: () => [...pending.values()].map(({ request }) => structuredClone(request)),
		respond(requestId, response) {
			const entry = pending.get(requestId);
			if (!entry || typeof response.value === "string" && response.value.length > 128 * 1024) return false;
			entry.resolve(response);
			return true;
		},
		cancelPending() {
			for (const entry of [...pending.values()]) entry.resolve({ cancelled: true });
		},
		reconcileResources(views) {
			const available = new Set(views.map((view) => view.id));
			for (const entry of [...pending.values()]) if (entry.request.method === "resource" && !available.has(entry.request.resourceView?.id ?? "")) entry.resolve({ cancelled: true });
		},
		resetDecorations() {
			for (const key of statuses.keys()) opts.publish({ type: "extension_ui", id: randomUUID(), method: "setStatus", statusKey: key, ts: Date.now() });
			for (const key of widgets.keys()) opts.publish({ type: "extension_ui", id: randomUUID(), method: "setWidget", widgetKey: key, ts: Date.now() });
			statuses.clear(); widgets.clear(); title = undefined;
			opts.publish({ type: "extension_ui", id: randomUUID(), method: "setTitle", title: "", ts: Date.now() });
			opts.publish({ type: "extension_ui", id: randomUUID(), method: "setWorkingMessage", ts: Date.now() });
		},
		dispose() {
			disposed = true;
			for (const entry of pending.values()) entry.resolve({ cancelled: true });
			pending.clear();
		},
	};
}

export type { UiMethod };
