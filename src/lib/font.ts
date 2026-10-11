/**
 * 字体族偏好：界面字体与代码字体各自独立选择。
 * 与字号（piweb.fontSize / piweb.chatFontSize，见 theme.ts applyFontSize）分开，
 * 存 localStorage：piweb.fontUi / piweb.fontMono，
 * 通过覆盖 CSS 变量 --font-ui / --font-mono 生效（变量默认值见 globals.css）。
 *
 * 值有两种写法：
 *   - 预设 id（如 "maple" / "system" / "jetbrains"）
 *   - 自定义字体栈，前缀 "custom:"（如 "custom:Fira Code, monospace"）
 */

export type FontScope = "ui" | "mono";

export const DEFAULT_FONT_STACK: Record<FontScope, string> = {
	ui: '"Maple Mono CN", ui-monospace, SFMono-Regular, Menlo, Consolas, "PingFang SC", "Microsoft YaHei", monospace',
	mono: '"Maple Mono CN", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
};

export interface FontPreset {
	id: string;
	stack: string;
	label: { zh: string; en: string };
}

export const FONT_PRESETS: Record<FontScope, FontPreset[]> = {
	ui: [
		{ id: "maple", stack: DEFAULT_FONT_STACK.ui, label: { zh: "Maple Mono CN（默认）", en: "Maple Mono CN (default)" } },
		{ id: "system", stack: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif', label: { zh: "系统默认", en: "System default" } },
		{ id: "noto", stack: '"Noto Sans SC", ui-sans-serif, system-ui, "PingFang SC", "Microsoft YaHei", sans-serif', label: { zh: "思源黑体", en: "Noto Sans SC" } },
	],
	mono: [
		{ id: "maple", stack: DEFAULT_FONT_STACK.mono, label: { zh: "Maple Mono CN（默认）", en: "Maple Mono CN (default)" } },
		{ id: "system", stack: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", label: { zh: "系统等宽", en: "System monospace" } },
		{ id: "jetbrains", stack: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', label: { zh: "JetBrains Mono", en: "JetBrains Mono" } },
		{ id: "fira", stack: '"Fira Code", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', label: { zh: "Fira Code", en: "Fira Code" } },
	],
};

export const CUSTOM_PREFIX = "custom:";
const KEY: Record<FontScope, string> = { ui: "piweb.fontUi", mono: "piweb.fontMono" };
const CSS_VAR: Record<FontScope, string> = { ui: "--font-ui", mono: "--font-mono" };

/** localStorage 里的原始偏好（预设 id 或 custom: 前缀的字体栈） */
export function loadFontChoice(scope: FontScope): string | null {
	if (typeof window === "undefined") return null;
	try {
		return localStorage.getItem(KEY[scope]);
	} catch {
		return null;
	}
}

/** 把偏好解析成可直接写进 CSS 变量的字体栈；无法识别时回落默认 */
export function resolveFontStack(scope: FontScope, stored: string | null): string {
	if (!stored) return DEFAULT_FONT_STACK[scope];
	if (stored.startsWith(CUSTOM_PREFIX)) {
		const custom = stored.slice(CUSTOM_PREFIX.length).trim();
		return custom || DEFAULT_FONT_STACK[scope];
	}
	return FONT_PRESETS[scope].find((p) => p.id === stored)?.stack ?? DEFAULT_FONT_STACK[scope];
}

/** 应用并持久化；value 传 null 表示恢复默认（移除内联覆盖 + 清 localStorage） */
export function applyFontChoice(scope: FontScope, value: string | null): void {
	if (typeof window === "undefined") return;
	const root = document.documentElement;
	try {
		if (!value) {
			root.style.removeProperty(CSS_VAR[scope]);
			localStorage.removeItem(KEY[scope]);
			return;
		}
		root.style.setProperty(CSS_VAR[scope], resolveFontStack(scope, value));
		localStorage.setItem(KEY[scope], value);
	} catch {
		/* ignore */
	}
}

/** 启动 / 系统主题变化 / 跨标签同步时重放两处字体偏好 */
export function applyAllFonts(): void {
	applyFontChoice("ui", loadFontChoice("ui"));
	applyFontChoice("mono", loadFontChoice("mono"));
}
