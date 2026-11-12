/**
 * 界面与对话正文字体族偏好。
 * 与字号（piweb.fontSize / piweb.chatFontSize，见 theme.ts applyFontSize）分开，
 * 存 localStorage：piweb.fontUi，通过覆盖 CSS 变量 --font-ui 生效（默认值见 globals.css）。
 *
 * 代码字体（--font-mono）不再可配：固定为系统等宽（见 globals.css 的 --font-mono）。
 * 原先的 piweb.fontMono 偏好会被清掉，避免旧值残留却已无入口可改。
 *
 * 仅保留 maple / reading / noto 三个预设。
 * 旧 system 与 custom: 字体栈会迁移到 reading，使设置与实际字体保持一致。
 */

export const DEFAULT_FONT_STACK =
	'"Maple Mono CN", ui-monospace, SFMono-Regular, Menlo, Consolas, "PingFang SC", "Microsoft YaHei", monospace';
export const SYSTEM_FONT_STACK =
	'ui-sans-serif, system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';

export interface FontPreset {
	id: string;
	stack: string;
	label: { zh: string; en: string };
	description?: { zh: string; en: string };
}

export const FONT_PRESETS: FontPreset[] = [
	{ id: "maple", stack: DEFAULT_FONT_STACK, label: { zh: "Maple Mono CN（默认）", en: "Maple Mono CN (default)" } },
	{
		id: "reading",
		stack: SYSTEM_FONT_STACK,
		label: { zh: "阅读预设（系统无衬线）", en: "Reading preset (system sans)" },
		description: {
			zh: "界面与对话正文使用系统无衬线字体，代码保持系统等宽，适合长篇阅读。",
			en: "System sans-serif for the interface and message text, with system monospace for code. Suited to longer reading.",
		},
	},
	{ id: "noto", stack: '"Noto Sans SC", ui-sans-serif, system-ui, "PingFang SC", "Microsoft YaHei", sans-serif', label: { zh: "思源黑体", en: "Noto Sans SC" } },
];

const KEY = "piweb.fontUi";
/** 已废弃的代码字体偏好键：保留常量只为在启动时清掉历史残留 */
const RETIRED_MONO_KEY = "piweb.fontMono";
const CSS_VAR = "--font-ui";

function normalizeFontChoice(stored: string | null): string | null {
	if (stored === "system" || stored?.startsWith("custom:")) return "reading";
	return FONT_PRESETS.some((preset) => preset.id === stored) ? stored : null;
}

/** 读取预设；旧选择同时迁移存储与实际字体，首次打开设置也不会显示不一致。 */
export function loadFontChoice(): string | null {
	if (typeof window === "undefined") return null;
	try {
		const stored = localStorage.getItem(KEY);
		const choice = normalizeFontChoice(stored);
		if (choice !== stored) applyFontChoice(choice);
		return choice;
	} catch {
		return null;
	}
}

/** 把偏好解析成可直接写进 CSS 变量的字体栈；无法识别时回落默认 */
export function resolveFontStack(stored: string | null): string {
	const choice = normalizeFontChoice(stored);
	return FONT_PRESETS.find((p) => p.id === choice)?.stack ?? DEFAULT_FONT_STACK;
}

/** 应用并持久化；value 传 null 表示恢复默认（移除内联覆盖 + 清 localStorage） */
export function applyFontChoice(value: string | null): void {
	if (typeof window === "undefined") return;
	const root = document.documentElement;
	const choice = normalizeFontChoice(value);
	try {
		if (!choice) {
			root.style.removeProperty(CSS_VAR);
			localStorage.removeItem(KEY);
			return;
		}
		root.style.setProperty(CSS_VAR, resolveFontStack(choice));
		localStorage.setItem(KEY, choice);
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
