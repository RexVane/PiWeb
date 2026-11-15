import { describe, expect, it } from "vitest";
import { API_ERROR_I18N_KEYS } from "@/lib/api-error";
import { API_ERROR_LOCALE_KEYS, localizeApiError } from "@/i18n";

/**
 * 前端按 errorCode 本地化：errorCode → 词典 key 的两张表必须一致，
 * 且 zh/en 都有文案；没有映射时保留服务器消息（中文兜底）。
 */
describe("localizeApiError", () => {
	it("keeps the server mapping and the client dictionary table in sync", () => {
		expect(Object.keys(API_ERROR_LOCALE_KEYS).sort()).toEqual(Object.keys(API_ERROR_I18N_KEYS).sort());
		for (const [code, key] of Object.entries(API_ERROR_I18N_KEYS)) {
			expect(API_ERROR_LOCALE_KEYS[code]).toBe(key);
		}
	});

	it("localizes every mapped errorCode in both languages", () => {
		for (const code of Object.keys(API_ERROR_I18N_KEYS)) {
			const zh = localizeApiError("zh", code, "__fallback__");
			const en = localizeApiError("en", code, "__fallback__");
			expect(zh).not.toBe("__fallback__");
			expect(en).not.toBe("__fallback__");
			expect(zh).not.toBe("");
			expect(en).not.toBe("");
			expect(zh).not.toBe(en);
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
