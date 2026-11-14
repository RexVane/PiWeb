/**
 * 升权工具的纯文本约定：工具名稳定，结果文本 → 三种结论。
 * 前端的结果行（ChatWindow 的 permissionPreview）就靠这三个前缀，改文案会一起坏，所以钉住。
 */
import { describe, expect, it } from "vitest";
import { permissionOutcomeOf, REQUEST_PERMISSION_TOOL } from "@/lib/permission-request";

describe("permissionOutcomeOf", () => {
	it("recognises the three result texts", () => {
		expect(permissionOutcomeOf('Approved for one command at scope "full". Run exactly the command you described;')).toBe("approved");
		expect(permissionOutcomeOf("The user declined. Do not retry the blocked command")).toBe("denied");
		expect(permissionOutcomeOf("The user did not answer, so nothing was approved.")).toBe("unanswered");
	});

	it("returns unknown for anything else", () => {
		expect(permissionOutcomeOf("")).toBe("unknown");
		expect(permissionOutcomeOf("some other tool output")).toBe("unknown");
	});

	it("keeps the tool name stable", () => {
		expect(REQUEST_PERMISSION_TOOL).toBe("request_permission");
	});
});
