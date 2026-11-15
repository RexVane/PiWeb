/**
 * J-ISSUE-03：工作区别名（rename/add 的 name）无长度上限，100,000 字符会被持久化。
 * 修复：route 层超过 1000 字符直接 400；正常长度不误伤。
 */
import { describe, expect, it } from "vitest";
import { POST } from "@/app/api/workspaces/route";

function post(body: unknown): Promise<Response> {
	return POST(new Request("http://127.0.0.1/api/workspaces", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	}));
}

describe("/api/workspaces alias length validation", () => {
	it("rejects a 100,000 character alias on rename with 400", async () => {
		const response = await post({ action: "rename", path: "C:\\project", name: "N".repeat(100_000) });
		expect(response.status).toBe(400);
		const body = await response.json();
		expect(body.success).toBe(false);
		expect(body.errorCode).toBe("VALIDATION_ERROR");
		expect(body.error).toContain("too long");
	});

	it("rejects an over-long alias on add too", async () => {
		const response = await post({ action: "add", path: "C:\\project", name: "N".repeat(1001) });
		expect(response.status).toBe(400);
		expect((await response.json()).errorCode).toBe("VALIDATION_ERROR");
	});

	it("does not reject an alias at the 1000-character limit as over-long", async () => {
		// 只带 name 不带 path：长度检查通过后应报 missing path，而不是 workspace name is too long
		const response = await post({ action: "rename", name: "N".repeat(1000) });
		expect(response.status).toBe(400);
		const body = await response.json();
		expect(body.error).toBe("missing path");
	});
});
