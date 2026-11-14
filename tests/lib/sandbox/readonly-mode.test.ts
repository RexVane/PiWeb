/**
 * 只读模式的沙箱：一个可写目录都不给，命令能跑、读能读、写全被内核拒。
 *
 * 这就是「仅可查看」档放开 shell 的前提：不是靠工具白名单说"没有写工具"，
 * 而是让 `cmd`/`bash` 里的写入真的失败。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAclSandbox, type AclSandbox } from "@/lib/sandbox/windows-acl";
import { recycleFixture } from "./fixtures";

const win32 = process.platform === "win32";

describe.skipIf(!win32)("readonly sandbox mode", () => {
	let base: string;
	let workspace: string;
	let outside: string;
	let sandbox: AclSandbox | null = null;

	beforeAll(async () => {
		base = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-acl-readonly-"));
		workspace = path.join(base, "workspace");
		outside = path.join(base, "outside");
		await fs.mkdir(workspace, { recursive: true });
		await fs.mkdir(outside, { recursive: true });
		await fs.writeFile(path.join(outside, "readable.txt"), "outside-readable");
		// 只读：不给任何可写目录，也不给私有 temp
		sandbox = await createAclSandbox({ writableDirs: [], readableDirs: [workspace, outside], tempDir: null });
	});
	beforeEach((ctx) => { if (!sandbox) ctx.skip("AppContainer runtime unavailable"); });

	afterAll(async () => {
		await sandbox?.dispose();
		await recycleFixture(base);
	});

	it("still runs read-only commands", async () => {
		const chunks: Buffer[] = [];
		const result = await sandbox!.exec("type nul", { cwd: workspace, onData: (chunk) => chunks.push(chunk) });
		expect(result.exitCode).toBe(0);
	});

	it("refuses writes inside the workspace too", async () => {
		const target = path.join(workspace, "blocked.txt");
		const result = await sandbox!.exec(`echo nope> ${target}`, { cwd: workspace });
		expect(result.exitCode).not.toBe(0);
		await expect(fs.access(target)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("refuses writes outside and outside temp usage", async () => {
		const target = path.join(outside, "blocked.txt");
		const result = await sandbox!.exec(`echo nope> ${target}`, { cwd: workspace });
		expect(result.exitCode).not.toBe(0);
		await expect(fs.access(target)).rejects.toMatchObject({ code: "ENOENT" });
		// TMP 没有指向可写目录：命令自己写临时文件也会失败
		const temp = await sandbox!.exec("echo nope> %TEMP%\\piweb-readonly-probe.txt", { cwd: workspace });
		expect(temp.exitCode).not.toBe(0);
	});

	it("reads explicitly allowed files", async () => {
		const chunks: Buffer[] = [];
		const result = await sandbox!.exec(`type ${path.join(outside, "readable.txt")}`, { cwd: workspace, onData: (chunk) => chunks.push(chunk) });
		expect(result.exitCode).toBe(0);
		expect(Buffer.concat(chunks).toString("utf8")).toContain("outside-readable");
	});
	it("cannot write a root that another workspace sandbox has made writable", async () => {
		const writable = await createAclSandbox({ writableDirs: [workspace], tempDir: path.join(base, "temp") });
		expect(writable).not.toBeNull();
		try {
			const target = path.join(workspace, "readonly-after-workspace.txt");
			expect((await sandbox!.exec('echo nope>"' + target + '"', { cwd: workspace })).exitCode).not.toBe(0);
			await expect(fs.access(target)).rejects.toMatchObject({ code: "ENOENT" });
		} finally { await writable?.dispose(); }
	});
});
