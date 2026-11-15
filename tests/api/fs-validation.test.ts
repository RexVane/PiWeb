/**
 * J-ISSUE-02：/api/fs 收到含 NUL 字节的 path 时曾由 node:fs 抛 ERR_INVALID_ARG_VALUE → 500。
 * 输入错误必须在进 fs 之前收敛为 400，且响应体不暴露 Node 错误码。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { POST } from "@/app/api/fs/route";

const roots: string[] = [];

afterEach(async () => {
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

function call(body: unknown): Promise<Response> {
	return POST(new Request("http://127.0.0.1/api/fs", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	}));
}

describe("/api/fs NUL-byte path validation", () => {
	it("rejects a path containing a NUL byte with 400 instead of 500", async () => {
		const response = await call({ action: "list", path: `C:\\Windows\u0000evil` });
		expect(response.status).toBe(400);
		const body = await response.json();
		expect(body).toMatchObject({ success: false, errorCode: "VALIDATION_ERROR" });
		expect(JSON.stringify(body)).not.toContain("ERR_INVALID_ARG_VALUE");
	});

	it("rejects NUL bytes in the middle and at the end of an absolute path", async () => {
		for (const target of ["C:\\Win\u0000dows", "C:\\Windows\u0000"]) {
			const response = await call({ action: "list", path: target });
			expect(response.status, JSON.stringify(target)).toBe(400);
		}
	});

	it("still lists a real directory normally", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-fs-nul-"));
		roots.push(root);
		await fs.mkdir(path.join(root, "child"));
		const response = await call({ action: "list", path: root });
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.data.entries).toEqual([expect.objectContaining({ name: "child" })]);
	});

	it("keeps other invalid inputs as 400", async () => {
		for (const target of [42, "", "relative/path", "C:\\" + "a".repeat(4100)]) {
			const response = await call({ action: "list", path: target });
			expect(response.status, JSON.stringify(target).slice(0, 40)).toBe(400);
		}
	});
});
