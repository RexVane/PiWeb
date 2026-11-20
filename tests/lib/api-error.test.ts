import { describe, expect, it } from "vitest";
import { API_ERROR_I18N_KEYS, apiError, apiErrorI18nKey } from "@/lib/api-error";
import { BoundaryError } from "@/lib/path-security";

/** 后端错误 → 稳定 errorCode 的契约：前端按 errorCode 本地化，缺失时回退服务器消息。 */
describe("apiError", () => {
	it("keeps the existing Chinese fallback for unknown failures", () => {
		expect(apiError(new Error("boom"))).toEqual({ error: "请求失败，请重试。", errorCode: "REQUEST_FAILED" });
		expect(apiError(new Error("boom"), "自定义失败，请重试。")).toEqual({ error: "自定义失败，请重试。", errorCode: "REQUEST_FAILED" });
	});

	it("keeps the original Chinese messages for known OS error codes", () => {
		const enoent = Object.assign(new Error("missing"), { code: "ENOENT" });
		const eacces = Object.assign(new Error("denied"), { code: "EACCES" });
		const etimedout = Object.assign(new Error("slow"), { code: "ETIMEDOUT" });
		expect(apiError(enoent)).toEqual({ error: "请求的资源不存在。", errorCode: "ENOENT" });
		expect(apiError(eacces)).toEqual({ error: "没有权限访问请求的资源。", errorCode: "EACCES" });
		expect(apiError(etimedout)).toEqual({ error: "操作超时，请重试。", errorCode: "ETIMEDOUT" });
	});

	it("recovers an OS code wrapped inside an SDK storage error", () => {
		expect(apiError(new Error("ENOENT: no such file, open 'settings.json'")).errorCode).toBe("ENOENT");
		expect(apiError(new Error("spawn git EACCES")).errorCode).toBe("EACCES");
	});

	it("reports invalid JSON and validation errors without leaking local paths", () => {
		expect(apiError(new SyntaxError("Unexpected token <"))).toEqual({ error: "请求内容不是有效的 JSON。", errorCode: "INVALID_JSON" });
		expect(apiError(new BoundaryError("path escapes the workspace"))).toEqual({ error: "path escapes the workspace", errorCode: "VALIDATION_ERROR" });
		const validation = apiError(new Error("bad path C:\\Users\\me\\secret.txt"), "校验失败", true);
		expect(validation.errorCode).toBe("VALIDATION_ERROR");
		expect(validation.error).not.toContain("C:\\Users\\me");
	});

	it("passes a BoundaryError's machine-readable code through so clients can tell越界 from 不存在", () => {
		expect(apiError(new BoundaryError("path escapes the workspace", "OUT_OF_WORKSPACE")))
			.toEqual({ error: "path escapes the workspace", errorCode: "OUT_OF_WORKSPACE" });
		expect(apiError(new BoundaryError("file not found", "NOT_FOUND")))
			.toEqual({ error: "file not found", errorCode: "NOT_FOUND" });
		// 格式不合法的 code 不透传：宁缺勿滥，避免把任意字符串当错误码
		expect(apiError(new BoundaryError("x", "lower-case")).errorCode).toBe("VALIDATION_ERROR");
		expect(apiError(new BoundaryError("x", "X".repeat(60))).errorCode).toBe("VALIDATION_ERROR");
	});

	it("explains Trash failure without revealing commands or inventing a permanent-delete fallback", () => {
		const failure = apiError(Object.assign(new Error("osascript failed /Users/private/secret.md"), { code: "TRASH_UNAVAILABLE" }));
		expect(failure).toEqual({ errorCode: "TRASH_UNAVAILABLE", error: "无法移到系统回收站，未执行永久删除。请检查回收站、磁盘和系统权限后重试。" });
	});

	it("only accepts upper-case error codes with a bounded length", () => {
		expect(apiError(Object.assign(new Error("x"), { code: "ENOSPC" })).errorCode).toBe("ENOSPC");
		expect(apiError(Object.assign(new Error("x"), { code: "custom" })).errorCode).toBe("REQUEST_FAILED");
		expect(apiError(Object.assign(new Error("x"), { code: "X".repeat(60) })).errorCode).toBe("REQUEST_FAILED");
	});

	it("maps every localizable errorCode to a client dictionary key", () => {
		const expected: Record<string, string> = {
			INVALID_JSON: "apiErrorInvalidJson",
			VALIDATION_ERROR: "apiErrorValidation",
			OUT_OF_WORKSPACE: "apiErrorOutOfWorkspace",
			NOT_FOUND: "apiErrorEnoent",
			NOT_A_FILE: "apiErrorNotAFile",
			FILE_NOT_FOUND: "apiErrorEnoent",
			IS_DIRECTORY: "apiErrorNotAFile",
			QUEUE_CHANGED: "apiErrorQueueChanged",
			QUEUE_EDIT_UNSUPPORTED: "apiErrorQueueEditUnsupported",
			ENOENT: "apiErrorEnoent",
			EACCES: "apiErrorEacces",
			EPERM: "apiErrorEperm",
			ELOCKED: "apiErrorElocked",
			EBUSY: "apiErrorEbusy",
			ENOSPC: "apiErrorEnospc",
			ETIMEDOUT: "apiErrorEtimedout",
			REQUEST_FAILED: "apiErrorRequestFailed",
			TRASH_UNAVAILABLE: "apiErrorTrashUnavailable",
		};
		expect(API_ERROR_I18N_KEYS).toEqual(expected);
		for (const [code, key] of Object.entries(expected)) {
			expect(apiErrorI18nKey(code)).toBe(key);
			expect(key).toMatch(/^apiError[A-Z][A-Za-z]+$/);
		}
		expect(apiErrorI18nKey(undefined)).toBeUndefined();
		expect(apiErrorI18nKey("")).toBeUndefined();
		expect(apiErrorI18nKey("GROWTH_NOT_A_REPO")).toBeUndefined();
	});
});
