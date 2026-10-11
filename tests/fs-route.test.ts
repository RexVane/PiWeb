/**
 * /api/fs：应用内目录浏览器的后端（远程设备选工作区时用）。
 * 契约：只列目录、只读；路径必须绝对；不存在/无权限都返回 400 而不是 500。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { POST } from "../src/app/api/fs/route";

function call(body: unknown): Promise<Response> {
	return POST(
		new Request("http://127.0.0.1/api/fs", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		}),
	);
}

describe("/api/fs", () => {
	it("roots 至少给出一个绝对路径起点", async () => {
		const res = await call({ action: "roots" });
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.success).toBe(true);
		expect(Array.isArray(body.data.roots)).toBe(true);
		expect(body.data.roots.length).toBeGreaterThan(0);
		for (const root of body.data.roots) expect(path.isAbsolute(root.path)).toBe(true);
	});

	it("list 只列目录（文件不算），并给出父目录", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-fs-"));
		try {
			await fs.mkdir(path.join(dir, "sub"));
			await fs.writeFile(path.join(dir, "file.txt"), "x");
			const res = await call({ action: "list", path: dir });
			const body = await res.json();
			expect(body.success).toBe(true);
			expect(body.data.entries.map((entry: { name: string }) => entry.name)).toEqual(["sub"]);
			expect(body.data.parent).toBe(path.dirname(await fs.realpath(dir)));
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("相对路径、不存在的目录都被拒（400，不是 500）", async () => {
		expect((await call({ action: "list", path: "relative/dir" })).status).toBe(400);
		expect((await call({ action: "list", path: path.join(os.tmpdir(), "piweb-no-such-dir-xyz") })).status).toBe(400);
	});

	it("未知 action 返回 400，非对象 body 也返回 400", async () => {
		expect((await call({ action: "nope" })).status).toBe(400);
		expect((await call([1, 2, 3])).status).toBe(400);
	});
});
