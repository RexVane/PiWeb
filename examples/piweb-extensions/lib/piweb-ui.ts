/**
 * PiWeb 扩展 UI 小工具（复制到你自己的扩展包里用，不依赖 PiWeb 源码）。
 *
 * 用法：同一个面板做两份渲染——终端用原来的 renderer，PiWeb 用 `ctx.ui.web(tree)`。
 * 数据、状态、逻辑完全共用，只有"怎么画"不同。
 */

export type WebUiTone = "default" | "muted" | "accent" | "success" | "warning" | "danger";

export interface WebUiListItem {
	label: string;
	description?: string;
	/** 点中后回传给扩展的标识 */
	action?: string;
	disabled?: boolean;
}

export interface WebUiFormField {
	kind: "input" | "select" | "confirm";
	name: string;
	label: string;
	placeholder?: string;
	value?: string;
	options?: string[];
}

export type WebUiNode =
	| { type: "box"; direction?: "row" | "column"; gap?: number; children: WebUiNode[] }
	| { type: "text"; text: string; tone?: WebUiTone; mono?: boolean }
	| { type: "list"; items: WebUiListItem[]; selected?: number }
	| { type: "table"; columns: string[]; rows: string[][] }
	| { type: "progress"; value: number; label?: string }
	| { type: "code"; text: string; language?: string }
	| { type: "form"; fields: WebUiFormField[]; submitLabel?: string };

export interface WebUiResult {
	action?: string;
	name?: string;
	values?: Record<string, string | boolean>;
}

export interface PiWebUi {
	web(tree: WebUiNode, options?: { title?: string; timeout?: number }): Promise<WebUiResult | undefined>;
}

/** 宿主是不是 PiWeb（pi 的终端 uiContext 没有 web 方法） */
export function piwebUi(ui: unknown): PiWebUi | null {
	const candidate = ui as { web?: unknown } | null | undefined;
	if (!candidate || typeof candidate.web !== "function") return null;
	return candidate as unknown as PiWebUi;
}

// ---------- 节点构造器（省得手写对象） ----------

export const txt = (text: string, tone?: WebUiTone, mono = false): WebUiNode => ({
	type: "text",
	text,
	...(tone ? { tone } : {}),
	...(mono ? { mono: true } : {}),
});

export const col = (...children: WebUiNode[]): WebUiNode => ({ type: "box", direction: "column", gap: 10, children });
export const row = (...children: WebUiNode[]): WebUiNode => ({ type: "box", direction: "row", gap: 10, children });

export const list = (items: WebUiListItem[], selected?: number): WebUiNode => ({
	type: "list",
	items,
	...(selected !== undefined ? { selected } : {}),
});

export const progress = (value: number, label?: string): WebUiNode => ({
	type: "progress",
	value: Math.min(1, Math.max(0, value)),
	...(label ? { label } : {}),
});

export const table = (columns: string[], rows: string[][]): WebUiNode => ({ type: "table", columns, rows });
export const code = (text: string, language?: string): WebUiNode => ({ type: "code", text, ...(language ? { language } : {}) });
export const form = (fields: WebUiFormField[], submitLabel?: string): WebUiNode => ({
	type: "form",
	fields,
	...(submitLabel ? { submitLabel } : {}),
});

/**
 * 终端侧：调用 pi 的 custom() 打开组件。
 * PiWeb 侧调用 custom() 时，如果拿到的不是界面树，会把同一个组件的 render() 结果当纯文本显示。
 */
export async function openTerminalPanel<T = unknown>(
	ui: unknown,
	component: { render(width: number): string[] },
	options?: { title?: string },
): Promise<T | undefined> {
	const custom = (ui as { custom?: unknown } | null)?.custom;
	if (typeof custom !== "function") return undefined;
	try {
		const factory = () => component;
		return (await (custom as (f: unknown, o?: unknown) => Promise<T>).call(ui, factory, options)) ?? undefined;
	} catch {
		return undefined;
	}
}
