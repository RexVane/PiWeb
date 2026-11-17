import { describe, expect, it } from "vitest";
import { API_ERROR_I18N_KEYS } from "@/lib/api-error";
import { API_ERROR_LOCALE_KEYS, localizeApiError, TRANSLATIONS } from "@/i18n";
import { LANGUAGES, htmlLangOf, isLang } from "@/lib/lang";

/**
 * 前端按 errorCode 本地化：errorCode → 词典 key 的两张表必须一致，
 * 且每种界面语言都有文案；没有映射时保留服务器消息（中文兜底）。
 */
describe("localizeApiError", () => {
	it("keeps the server mapping and the client dictionary table in sync", () => {
		expect(Object.keys(API_ERROR_LOCALE_KEYS).sort()).toEqual(Object.keys(API_ERROR_I18N_KEYS).sort());
		for (const [code, key] of Object.entries(API_ERROR_I18N_KEYS)) {
			expect(API_ERROR_LOCALE_KEYS[code]).toBe(key);
		}
	});

	it("localizes every mapped errorCode in all five languages", () => {
		for (const { value: lang } of LANGUAGES) {
			for (const code of Object.keys(API_ERROR_I18N_KEYS)) {
				const message = localizeApiError(lang, code, "__fallback__");
				expect(message, `${lang}:${code}`).not.toBe("__fallback__");
				expect(message, `${lang}:${code}`).not.toBe("");
			}
		}
	});

	it("prefers the mapped message over the server message", () => {
		expect(localizeApiError("en", "ENOENT", "请求的资源不存在。")).toBe("The requested resource does not exist.");
		expect(localizeApiError("zh", "ENOENT", "请求的资源不存在。")).toBe("请求的资源不存在。");
		expect(localizeApiError("en", "VALIDATION_ERROR", "请求参数无效，请检查后重试。")).toContain("parameters are invalid");
	});

	it("falls back to the original server message for unknown codes", () => {
		expect(localizeApiError("en", "GROWTH_NOT_A_REPO", "该目录不是 Git 仓库。")).toBe("该目录不是 Git 仓库。");
		expect(localizeApiError("en", undefined, "服务器返回的消息")).toBe("服务器返回的消息");
		expect(localizeApiError("zh", "CUSTOM_CODE", "自定义消息")).toBe("自定义消息");
	});

	it("falls back to the localized generic text without a code or message", () => {
		expect(localizeApiError("zh", undefined)).toBe("请求失败，请重试。");
		expect(localizeApiError("en", "UNKNOWN")).toBe("Request failed. Please try again.");
		expect(localizeApiError("en", "UNKNOWN", "  ")).toBe("Request failed. Please try again.");
	});
});

describe("language catalog", () => {
	it("offers English, Simplified/Traditional Chinese, Japanese and Russian", () => {
		expect(LANGUAGES.map((language) => language.value)).toEqual(["zh", "zh-Hant", "en", "ja", "ru"]);
		expect(LANGUAGES.every((language) => language.label.trim().length > 0)).toBe(true);
	});

	it("validates saved language values and maps them to <html lang>", () => {
		expect(isLang("zh-Hant")).toBe(true);
		expect(isLang("ja")).toBe(true);
		expect(isLang("ru")).toBe(true);
		expect(isLang("pt-BR")).toBe(false);
		expect(isLang(undefined)).toBe(false);
		expect(htmlLangOf("zh")).toBe("zh-CN");
		expect(htmlLangOf("zh-Hant")).toBe("zh-Hant");
		expect(htmlLangOf("en")).toBe("en");
		expect(htmlLangOf("ja")).toBe("ja");
		expect(htmlLangOf("ru")).toBe("ru");
	});
});

describe("translation dictionaries", () => {
	const source = TRANSLATIONS.zh;
	const placeholders = (value: string) => [...value.matchAll(/\{[a-zA-Z0-9_]+\}/g)].map((match) => match[0]).sort();

	it("have identical key sets and non-empty values in every language", () => {
		const expectedKeys = Object.keys(source).sort();
		for (const { value: lang } of LANGUAGES) {
			const dict = TRANSLATIONS[lang];
			expect(Object.keys(dict).sort(), lang).toEqual(expectedKeys);
			for (const key of expectedKeys) {
				expect(dict[key as keyof typeof dict], `${lang}:${key}`).toBeTruthy();
			}
		}
	});

	it("keep every {placeholder} of the Chinese source in each translation", () => {
		for (const { value: lang } of LANGUAGES) {
			const dict = TRANSLATIONS[lang];
			for (const key of Object.keys(source) as Array<keyof typeof source>) {
				expect(placeholders(dict[key]), `${lang}:${key}`).toEqual(placeholders(source[key]));
			}
		}
	});

	it("actually translate the API error strings instead of copying Chinese", () => {
		for (const lang of ["en", "ja", "ru", "zh-Hant"] as const) {
			const dict = TRANSLATIONS[lang];
			expect(dict.apiErrorRequestFailed).not.toBe(source.apiErrorRequestFailed);
			expect(dict.settings).not.toBe(source.settings);
		}
	});
});
