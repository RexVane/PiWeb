/**
 * 界面字体族偏好。
 * 与字号（piweb.fontSize / piweb.chatFontSize，见 theme.ts applyFontSize）分开，
 * 存 localStorage：piweb.fontUi，通过覆盖 CSS 变量 --font-ui 生效（默认值见 globals.css）。
 *
 * 代码字体（--font-mono）不再可配：固定为系统等宽（见 globals.css 的 --font-mono）。
 * 原先的 piweb.fontMono 偏好会被清掉，避免旧值残留却已无入口可改。
 *
 * 值有两种写法：
 *   - 预设 id（如 "maple" / "system" / "noto"）
 *   - 自定义字体栈，前缀 "custom:"（如 "custom:Fira Code, monospace"）
 */

export const DEFAULT_FONT_STACK =
	'"Maple Mono CN", ui-monospace, SFMono-Regular, Menlo, Consolas, "PingFang SC", "Microsoft YaHei", monospace';

export interface FontPreset {
	id: string;
	stack: string;
	label: { zh: string; en: string };
}

export const FONT_PRESETS: FontPreset[] = [
	{ id: "maple", stack: DEFAULT_FONT_STACK, label: { zh: "Maple Mono CN（默认）", en: "Maple Mono CN (default)" } },
	{ id: "system", stack: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif', label: { zh: "系统默认", en: "System default" } },
	{ id: "noto", stack: '"Noto Sans SC", ui-sans-serif, system-ui, "PingFang SC", "Microsoft YaHei", sans-serif', label: { zh: "思源黑体", en: "Noto Sans SC" } },
];

export const CUSTOM_PREFIX = "custom:";
const KEY = "piweb.fontUi";
/** 已废弃的代码字体偏好键：保留常量只为在启动时清掉历史残留 */
const RETIRED_MONO_KEY = "piweb.fontMono";
const CSS_VAR = "--font-ui";

/** localStorage 里的原始偏好（预设 id 或 custom: 前缀的字体栈） */
export function loadFontChoice(): string | null {
	if (typeof window === "undefined") return null;
	try {
		return localStorage.getItem(KEY);
	} catch {
		return null;
	}
}

/** 把偏好解析成可直接写进 CSS 变量的字体栈；无法识别时回落默认 */
export function resolveFontStack(stored: string | null): string {
	if (!stored) return DEFAULT_FONT_STACK;
	if (stored.startsWith(CUSTOM_PREFIX)) {
		const custom = stored.slice(CUSTOM_PREFIX.length).trim();
		return custom || DEFAULT_FONT_STACK;
	}
	return FONT_PRESETS.find((p) => p.id === stored)?.stack ?? DEFAULT_FONT_STACK;
}

/** 应用并持久化；value 传 null 表示恢复默认（移除内联覆盖 + 清 localStorage） */
export function applyFontChoice(value: string | null): void {
	if (typeof window === "undefined") return;
	const root = document.documentElement;
	try {
		if (!value) {
			root.style.removeProperty(CSS_VAR);
			localStorage.removeItem(KEY);
			return;
		}
		root.style.setProperty(CSS_VAR, resolveFontStack(value));
		localStorage.setItem(KEY, value);
	} catch {
		/* ignore */
	}
}

/** 启动 / 系统主题变化 / 跨标签同步时重放字体偏好 */
export function applyAllFonts(): void {
	// 代码字体设置已移除：清掉旧偏好，并移除可能残留的内联覆盖（--font-mono 现在由 CSS 决定）
	try {
		localStorage.removeItem(RETIRED_MONO_KEY);
		document.documentElement.style.removeProperty("--font-mono");
	} catch {
		/* ignore */
	}
	applyFontChoice(loadFontChoice());
}
