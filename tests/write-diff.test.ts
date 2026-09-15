/**
 * 写入路径的 diff 一致性：新增行绿、删除行红。
 *
 * edit 工具自带 patch，而 write 工具不产 patch（SDK 的 write.js 里没有 patch 字段），
 * 覆盖已有文件时以前只能把全部内容当新增行——删掉的行永远不会标红。
 * 这里钉住服务端补出的 patch：覆盖时有真实的 +/−，新建文件则没有 patch（前端全绿）。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { captureWriteBase, takeWritePatch } from "../src/lib/agent-manager";
import { parseUnifiedDiff } from "../src/components/DiffView";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

async function workspace() {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "piweb-write-diff-")));
	roots.push(root);
	return root;
}

const session = "C:/sessions/s1.jsonl";

describe("write tool diff", () => {
	it("produces a real add/delete diff when overwriting an existing file", async () => {
		const cwd = await workspace();
		const file = path.join(cwd, "main.py");
		await fs.writeFile(file, "line1\nline2\nline3\n", "utf8");
		const args = { path: "main.py", content: "line1\nCHANGED\nline3\nnew line\n" };

		captureWriteBase(cwd, session, "call-1", args);
		const patch = takeWritePatch(cwd, session, "call-1", args);

		expect(patch).toBeTruthy();
		const lines = parseUnifiedDiff(patch as string);
		expect(lines).toBeTruthy();
		const added = (lines ?? []).filter((l) => l.kind === "add").map((l) => l.text);
		const removed = (lines ?? []).filter((l) => l.kind === "del").map((l) => l.text);
		expect(added).toContain("CHANGED");
		expect(added).toContain("new line");
		expect(removed).toContain("line2");
	});

	it("has no patch for a brand new file (frontend renders it all green)", async () => {
		const cwd = await workspace();
		const args = { path: "fresh.py", content: "a\nb\n" };
		captureWriteBase(cwd, session, "call-2", args);
		expect(takeWritePatch(cwd, session, "call-2", args)).toBeUndefined();
	});

	it("has no patch when the content is unchanged", async () => {
		const cwd = await workspace();
		const file = path.join(cwd, "same.txt");
		await fs.writeFile(file, "same\n", "utf8");
		const args = { path: "same.txt", content: "same\n" };
		captureWriteBase(cwd, session, "call-3", args);
		expect(takeWritePatch(cwd, session, "call-3", args)).toBeUndefined();
	});

	it("skips binary and oversized files instead of emitting a broken diff", async () => {
		const cwd = await workspace();
		const binary = path.join(cwd, "blob.bin");
		await fs.writeFile(binary, Buffer.from([0x00, 0x01, 0x02, 0x00]));
		const args = { path: "blob.bin", content: "text\n" };
		captureWriteBase(cwd, session, "call-4", args);
		expect(takeWritePatch(cwd, session, "call-4", args)).toBeUndefined();
	});

	it("keeps the base per tool call so parallel writes cannot borrow each other's old content", async () => {
		const cwd = await workspace();
		await fs.writeFile(path.join(cwd, "a.txt"), "old-a\n", "utf8");
		await fs.writeFile(path.join(cwd, "b.txt"), "old-b\n", "utf8");
		captureWriteBase(cwd, session, "call-a", { path: "a.txt", content: "new-a\n" });
		captureWriteBase(cwd, session, "call-b", { path: "b.txt", content: "new-b\n" });
		const patchB = takeWritePatch(cwd, session, "call-b", { path: "b.txt", content: "new-b\n" });
		expect(patchB).toContain("old-b");
		expect(patchB).not.toContain("old-a");
		expect(takeWritePatch(cwd, session, "call-a", { path: "a.txt", content: "new-a\n" })).toContain("old-a");
	});
});
