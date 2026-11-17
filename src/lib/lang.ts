/**
 * 界面语言清单（server / client 共用，不能依赖 "use client" 的 i18n.tsx）。
 *
 * 英 / 中（简繁）/ 日 / 俄；`piweb.lang` cookie 与 localStorage 都存这里的 value。
 */
export type Lang = "zh" | "zh-Hant" | "en" | "ja" | "ru";

/** 语言选择器里的显示名（用各自语言书写） */
export const LANGUAGES: Array<{ value: Lang; label: string }> = [
	{ value: "zh", label: "中文" },
	{ value: "zh-Hant", label: "繁體中文" },
	{ value: "en", label: "English" },
	{ value: "ja", label: "日本語" },
	{ value: "ru", label: "Русский" },
];

export function isLang(value: unknown): value is Lang {
	return LANGUAGES.some((language) => language.value === value);
}

/** BCP-47 tag for the document; the Simplified dictionary is mainland Chinese. */
export function htmlLangOf(lang: Lang): string {
	return lang === "zh" ? "zh-CN" : lang;
}
