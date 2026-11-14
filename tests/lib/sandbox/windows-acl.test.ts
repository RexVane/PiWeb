import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createAclSandbox, probeAclSandboxCapability, type AclSandbox } from "@/lib/sandbox/windows-acl";
import { aclOf, recycleFixture } from "./fixtures";

const run = promisify(execFile);
const writeScript = 'module.exports=async({target,content="created-by-sandbox"})=>{await require("node:fs/promises").writeFile(target,content);};';
describe.skipIf(process.platform !== "win32" || process.arch !== "x64")("Windows AppContainer isolation", () => {
	let base: string, workspace: string, outside: string;
	let sandbox: AclSandbox | null = null;
	let unavailable: string | undefined;
	const boxes: AclSandbox[] = [];
	const create = async (writableDirs: string[], extra: Partial<Parameters<typeof createAclSandbox>[0]> = {}) => {
		const box = await createAclSandbox({ writableDirs, tempDir: path.join(base, "scratch-parent"), ...extra });
		if (box) boxes.push(box);
		return box;
	};
	beforeAll(async () => {
		const capability = await probeAclSandboxCapability();
		unavailable = capability.unsupportedReason;
		base = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-acl-"));
		workspace = path.join(base, "workspace"); outside = path.join(base, "outside");
		await fs.mkdir(workspace); await fs.mkdir(outside);
		await fs.writeFile(path.join(outside, "secret.txt"), "outside-readable");
		if (capability.available) sandbox = await create([workspace]);
	});
	beforeEach((ctx) => { if (!sandbox) ctx.skip(unavailable ?? "AppContainer runtime unavailable"); });
	afterAll(async () => {
		for (const box of boxes) await box.dispose();
		if (base) await recycleFixture(base);
	});
	it("writes an allowed file with the actual isolated Node runtime", async () => {
		const target = path.join(workspace, "inside.txt");
		expect((await sandbox!.runNode(writeScript, { target }, { cwd: workspace })).exitCode).toBe(0);
		expect(await fs.readFile(target, "utf8")).toBe("created-by-sandbox");
	});
	it("starts its private Node helper independently of inherited launcher preloads", async () => {
		try {
			vi.stubEnv("NODE_OPTIONS", "--require " + JSON.stringify(path.join(base, "launcher-preload-not-present.cjs")));
			vi.stubEnv("NODE_PATH", path.join(base, "launcher-modules-not-present"));
			const result = await sandbox!.runNode('module.exports=()=>({version:process.version,options:process.env.NODE_OPTIONS,path:process.env.NODE_PATH});', null, { cwd: workspace, env: { node_options: "--require also-missing.cjs", Node_Path: "not-present" } });
			expect(result.exitCode, result.output).toBe(0);
			expect(JSON.parse(result.output)).toEqual({ version: process.version, options: "", path: "" });
		} finally { vi.unstubAllEnvs(); }
	});
	it("pins an authorized root until its own ACL is revoked", async () => {
		const root = path.join(base, "pinned-root");
		await fs.mkdir(root);
		const box = await create([root]);
		expect(box).not.toBeNull();
		const moved = path.join(base, "pinned-root-moved");
		await expect(fs.rename(root, moved)).rejects.toMatchObject({ code: expect.stringMatching(/EPERM|EBUSY/) });
		await box!.dispose();
		await expect(fs.rename(root, moved)).resolves.toBeUndefined();
	});
	it("honors timeouts while a command continuously fills its output pipes", async () => {
		const started = Date.now();
		const result = await sandbox!.runNode('module.exports=()=>{const fs=require("node:fs");const chunk=Buffer.alloc(65536,120);for(;;)fs.writeSync(1,chunk);};', null, { cwd: workspace, timeout: 350 });
		expect(result.timedOut).toBe(true);
		expect(Date.now() - started).toBeLessThan(5000);
		expect(result.output.length).toBeLessThanOrEqual(8 * 1024 * 1024);
	});
	it("blocks shell and Node writes to existing user-owned outside files", async () => {
		expect((await sandbox!.exec('echo nope>"' + path.join(outside, "cmd.txt") + '"', { cwd: workspace })).exitCode).not.toBe(0);
		const result = await sandbox!.runNode(writeScript, { target: path.join(outside, "secret.txt") }, { cwd: workspace });
		expect(result.exitCode).not.toBe(0); expect(result.output).toMatch(/EPERM|EACCES/i);
		expect(await fs.readFile(path.join(outside, "secret.txt"), "utf8")).toBe("outside-readable");
	});
	it("reads an explicitly allowed root without granting write access", async () => {
		const box = await create([], { readableDirs: [outside], tempDir: null });
		expect(box).not.toBeNull();
		const result = await box!.runNode('module.exports=async({target})=>require("node:fs/promises").readFile(target,"utf8");', { target: path.join(outside, "secret.txt") }, { cwd: outside });
		expect(result.exitCode).toBe(0); expect(result.output).toBe("outside-readable");
		expect((await box!.runNode(writeScript, { target: path.join(outside, "blocked.txt") }, { cwd: outside })).exitCode).not.toBe(0);
	});
	it("streams shell output and transports literal/large environments", async () => {
		const chunks: Buffer[] = [];
		expect((await sandbox!.exec("echo hello-from-sandbox", { cwd: workspace, onData: (chunk) => chunks.push(chunk) })).exitCode).toBe(0);
		expect(Buffer.concat(chunks).toString()).toContain("hello-from-sandbox");
		const literal = '"quoted" & %PATH% 中文';
		const value = "x".repeat(200);
		const env = { ...Object.fromEntries(Array.from({ length: 96 }, (_, index) => ["PIWEB_TEST_ENV_" + index, value])), PIWEB_TEST_LITERAL: literal };
		const result = await sandbox!.runNode('module.exports=()=>({count:Object.keys(process.env).filter(k=>k.startsWith("PIWEB_TEST_ENV_")).length,last:process.env.PIWEB_TEST_ENV_95,literal:process.env.PIWEB_TEST_LITERAL});', null, { cwd: workspace, env });
		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.output)).toEqual({ count: 96, last: value, literal });
	});
	it("does not expose API keys, credentials, PiWeb auth or internal locks through inherited or overridden environments", async () => {
		const names = ["PI_WEB_LAUNCH_TOKEN", "PI_WEB_SECRET", "PI_WEB_SECRET_FILE", "PI_WEB_PASSWORD", "PIWEB_BUILD_LOCK_TOKEN", "PIWEB_BUILD_LOCK_FILE", "PIWEB_PROCESS_LOCK_TOKEN", "PIWEB_PROCESS_LOCK_FILE", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "AWS_ACCESS_KEY_ID", "AZURE_CLIENT_SECRET", "GITHUB_TOKEN", "MY_PASSWORD", "SERVICE_CREDENTIALS"];
		try {
			for (const name of names) vi.stubEnv(name, "test-internal-value");
			const result = await sandbox!.runNode('module.exports=({names})=>({internal:names.filter(name=>process.env[name]!==undefined),empty:process.env.PIWEB_TEST_EMPTY,proxy:process.env.HTTP_PROXY,config:process.env.TOKENIZERS_PARALLELISM,path:!!process.env.PATH});',
				{ names }, { cwd: workspace, env: { pi_web_launch_token: "test-overridden-token", piweb_process_lock_file: "test-overridden-lock-file", PIWEB_PROCESS_LOCK_TOKEN: "test-overridden-lock-token", OPENAI_API_KEY: "test-model-key", anthropic_api_key: "test-overridden-key", PIWEB_TEST_EMPTY: "", HTTP_PROXY: "http://127.0.0.1:9", TOKENIZERS_PARALLELISM: "false" } });
			expect(result.exitCode).toBe(0);
			expect(JSON.parse(result.output)).toEqual({ internal: [], empty: "", proxy: "http://127.0.0.1:9", config: "false", path: true });
		} finally { vi.unstubAllEnvs(); }
	});
	it("uses different SIDs for different sessions even on formerly Low roots", async () => {
		const second = path.join(base, "second"); await fs.mkdir(second);
		await run("icacls", [second, "/setintegritylevel", "(OI)(CI)Low"], { windowsHide: true });
		const other = await create([second]); expect(other).not.toBeNull();
		const target = path.join(second, "cross-session.txt");
		expect((await sandbox!.runNode(writeScript, { target }, { cwd: workspace })).exitCode).not.toBe(0);
		expect((await other!.runNode(writeScript, { target }, { cwd: second })).exitCode).toBe(0);
	});
	it("cannot gain outside write rights by changing an outside DACL as its owner", async () => {
		// icacls is copied into the permitted root so execution itself is not denied.
		const executable = path.join(workspace, "icacls.exe");
		await fs.copyFile(path.join(process.env.SystemRoot!, "System32", "icacls.exe"), executable);
		expect((await sandbox!.exec('"' + executable + '" "' + workspace + '"', { cwd: workspace })).exitCode).toBe(0);
		const target = path.join(outside, "secret.txt");
		const baseline = await aclOf(target);
		const result = await sandbox!.exec('"' + executable + '" "' + target + '" /grant *S-1-1-0:F', { cwd: workspace });
		expect(result.exitCode).not.toBe(0);
		expect(await aclOf(target)).toBe(baseline);
	});
	it("does not grant a junction's external target during creation", async () => {
		const root = path.join(base, "junction-root"); await fs.mkdir(root);
		await fs.symlink(outside, path.join(root, "escape"), "junction");
		const baseline = await aclOf(outside);
		const box = await create([root]); expect(box).not.toBeNull();
		expect((await box!.runNode(writeScript, { target: path.join(root, "escape", "junction.txt") }, { cwd: root })).exitCode).not.toBe(0);
		await box!.dispose();
		expect(await aclOf(outside)).toBe(baseline);
	});
	it("fails closed for an existing hard link without changing the external object ACL", async () => {
		const root = path.join(base, "hardlink-root"); await fs.mkdir(root);
		const source = path.join(outside, "secret.txt");
		await fs.link(source, path.join(root, "alias.txt"));
		const baseline = await aclOf(source);
		expect(await create([root])).toBeNull();
		expect(await aclOf(source)).toBe(baseline);
		expect(await fs.readFile(source, "utf8")).toBe("outside-readable");
	});
	it("cannot create a writable hard link to a readable external object", async () => {
		const root = path.join(base, "link-attempt-root"); await fs.mkdir(root);
		const box = await create([root], { readableDirs: [outside] }); expect(box).not.toBeNull();
		const target = path.join(outside, "secret.txt"), alias = path.join(root, "alias.txt");
		const script = 'module.exports=async({target,alias})=>{const fs=require("node:fs/promises");await fs.link(target,alias);await fs.writeFile(alias,"escaped");};';
		expect((await box!.runNode(script, { target, alias }, { cwd: root })).exitCode).not.toBe(0);
		expect(await fs.readFile(target, "utf8")).toBe("outside-readable");
	});
	it("preserves original labels and other active sandbox SID grants on disposal", async () => {
		const root = path.join(base, "shared-root"); await fs.mkdir(root);
		await run("icacls", [root, "/setintegritylevel", "(OI)(CI)Low"], { windowsHide: true });
		const before = await aclOf(root);
		const first = await create([root]), second = await create([root]);
		expect(first).not.toBeNull(); expect(second).not.toBeNull();
		await first!.dispose();
		expect((await second!.runNode(writeScript, { target: path.join(root, "still-permitted.txt") }, { cwd: root })).exitCode).toBe(0);
		await second!.dispose();
		expect(await aclOf(root)).toBe(before);
	});
	const detached = 'module.exports=async({target,wait})=>{const cp=require("node:child_process");const code="setTimeout(()=>require(\\"node:fs\\").writeFileSync("+JSON.stringify(target)+",\\"late\\"),700)";const child=cp.spawn(process.execPath,["-e",code],{detached:true,stdio:"ignore"});child.unref();if(wait)await new Promise(r=>setTimeout(r,5000));return "started";};';
	it.each(["timeout", "abort", "dispose", "shell-exit"] as const)("terminates detached descendants on %s", async (kind) => {
		const root = path.join(base, "job-" + kind); await fs.mkdir(root);
		const box = await create([root]); expect(box).not.toBeNull();
		const controller = new AbortController();
		const target = path.join(root, "late.txt");
		const pending = box!.runNode(detached, { target, wait: kind !== "shell-exit" }, { cwd: root, timeout: kind === "timeout" ? 250 : 5000, signal: controller.signal });
		if (kind === "abort" || kind === "dispose") {
			await new Promise((resolve) => setTimeout(resolve, 250));
			if (kind === "abort") controller.abort(); else await box!.dispose();
		}
		const result = await pending;
		if (kind === "timeout") expect(result.timedOut).toBe(true);
		if (kind === "abort" || kind === "dispose") expect(result.aborted).toBe(true);
		if (kind === "shell-exit") expect(result.exitCode).toBe(0);
		await new Promise((resolve) => setTimeout(resolve, 900));
		await expect(fs.access(target)).rejects.toMatchObject({ code: "ENOENT" });
	});
	it("stops forwarding output past the limit but lets the command finish", async () => {
		let total = 0;
		const result = await sandbox!.runNode('module.exports=()=>{process.stdout.write(Buffer.alloc(9*1024*1024,120));};', null, { cwd: workspace, onData: (chunk) => { total += chunk.length; } });
		expect(result.outputLimitExceeded).toBe(true); expect(result.exitCode).toBe(0);
		expect(total).toBe(8 * 1024 * 1024);
	});
	it("cleans staged scripts after spawner failure and handles an already-aborted signal", async () => {
		const spawner = vi.fn(() => { throw new Error("injected spawn failure"); });
		const box = await create([workspace], { spawnRestricted: spawner, shell: { path: "fake.exe", transport: "script" } }); expect(box).not.toBeNull();
		const before = await fs.readdir(box!.tempDir);
		await expect(box!.exec("echo test", { cwd: workspace })).rejects.toThrow("injected spawn failure");
		expect(await fs.readdir(box!.tempDir)).toEqual(before);
		spawner.mockClear();
		const controller = new AbortController(); controller.abort();
		expect(await box!.exec("echo test", { cwd: workspace, signal: controller.signal })).toMatchObject({ aborted: true });
		expect(spawner).not.toHaveBeenCalled();
	});
	it("fails closed for a missing or nonphysical writable root", async () => {
		expect(await create([path.join(base, "missing")])).toBeNull();
	});
	it("supports a writable private temp without letting readonly use it", async () => {
		const chunks: Buffer[] = [];
		expect((await sandbox!.exec("echo %TEMP%", { cwd: workspace, onData: (chunk) => chunks.push(chunk) })).exitCode).toBe(0);
		const temp = Buffer.concat(chunks).toString().trim();
		const target = path.join(temp, "workspace-temp.txt");
		expect((await sandbox!.runNode(writeScript, { target }, { cwd: workspace })).exitCode).toBe(0);
		const readonly = await create([], { tempDir: null });
		expect(readonly).not.toBeNull();
		expect((await readonly!.runNode(writeScript, { target }, { cwd: workspace })).exitCode).not.toBe(0);
		// The readonly instance's own lazily provisioned AppContainer Temp must
		// also stay unwritable, not only the other instance's private directory.
		const ownTemp = await readonly!.runNode("module.exports=()=>require('node:os').tmpdir();", null, { cwd: workspace });
		expect(ownTemp.exitCode).toBe(0);
		const ownTarget = path.join(ownTemp.output.trim(), "readonly-profile-temp.txt");
		expect((await readonly!.runNode(writeScript, { target: ownTarget }, { cwd: workspace })).exitCode).not.toBe(0);
		await expect(fs.stat(ownTarget)).rejects.toMatchObject({ code: "ENOENT" });
	});
	it("fails closed for a native Bash runtime instead of weakening global object isolation", async () => {
		const box = await create([workspace], { shell: { path: "D:\\git\\Git\\usr\\bin\\bash.exe", transport: "script", scriptExt: ".sh" } });
		expect(box).toBeNull();
	});});
