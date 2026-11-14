/**
 * 额外可写目录（`~/.pi/agent/web-sandbox.json`）。
 *
 * 这段配置是「工作区内修改」档唯一的放行口子，所以校验必须严格：
 * 相对路径、不存在、文件、符号链接根目录 —— 全部拒绝；写的时候严格（throw），
 * 读的时候宽容（坏条目跳过并告警），免得用户手改坏文件后 shell 直接不可用。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

let root: string;
let agentDir: string;
let shared: string;
let config: typeof import("@/lib/sandbox/config");

beforeAll(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-sandbox-config-"));
	agentDir = path.join(root, "agent");
	shared = path.join(root, "shared");
	await fs.mkdir(agentDir, { recursive: true });
	await fs.mkdir(shared, { recursive: true });
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
	vi.resetModules();
	config = await import("@/lib/sandbox/config");
});

afterAll(async () => {
	vi.unstubAllEnvs();
	await fs.rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
	await fs.rm(path.join(agentDir, "web-sandbox.json"), { force: true });
});

describe("additionalWritableRoots", () => {
	it("stores realpaths and reads them back", async () => {
		const written = await config.writeSandboxConfig({ additionalWritableRoots: [shared] });
		expect(written.additionalWritableRoots).toEqual([await fs.realpath(shared)]);
		expect(await config.readSandboxConfig()).toEqual({ additionalWritableRoots: [await fs.realpath(shared)] });
	});

	it("returns an empty list when the file is missing", async () => {
		expect(await config.readSandboxConfig()).toEqual({ additionalWritableRoots: [] });
	});

	it("rejects relative, missing and non-directory entries", async () => {
		const file = path.join(root, "plain.txt");
		await fs.writeFile(file, "x");
		for (const entry of ["relative/dir", path.join(root, "missing"), file]) {
			await expect(config.writeSandboxConfig({ additionalWritableRoots: [entry] })).rejects.toThrow();
		}
	});

	it("rejects a link root but accepts the link target explicitly", async () => {
		const link = path.join(root, "linked");
		await fs.symlink(shared, link, process.platform === "win32" ? "junction" : "dir");
		await expect(config.writeSandboxConfig({ additionalWritableRoots: [link] })).rejects.toThrow(/符号链接/);
		await expect(config.writeSandboxConfig({ additionalWritableRoots: [shared] })).resolves.toBeTruthy();
	});

	it("dedupes and caps the list", async () => {
		const written = await config.writeSandboxConfig({ additionalWritableRoots: [shared, shared, shared.toUpperCase()] });
		expect(written.additionalWritableRoots).toHaveLength(1);
		const many = Array.from({ length: 9 }, (_, index) => path.join(root, `d${index}`));
		for (const dir of many) await fs.mkdir(dir, { recursive: true });
		await expect(config.writeSandboxConfig({ additionalWritableRoots: many })).rejects.toThrow(/最多/);
	});

	it("skips broken entries when reading instead of failing", async () => {
		await fs.writeFile(path.join(agentDir, "web-sandbox.json"), JSON.stringify({ additionalWritableRoots: [path.join(root, "gone"), shared] }));
		expect((await config.readSandboxConfig()).additionalWritableRoots).toEqual([await fs.realpath(shared)]);
	});
});
