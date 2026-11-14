import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hasSandbox, probeSandboxSupport, releaseSandbox, resetSandboxStateForTests, sandboxCapability, sandboxFor, sandboxSupported } from "@/lib/sandbox/manager";
import { recycleFixture } from "./fixtures";

describe.skipIf(process.platform !== "win32" || process.arch !== "x64")("sandbox manager", () => {
	let workspace: string, base: string;
	let agentDir: string | undefined;
	beforeEach(async () => {
		await resetSandboxStateForTests();
		base = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-sandbox-manager-"));
		workspace = path.join(base, "workspace"); await fs.mkdir(workspace);
		agentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = path.join(base, "agent");
	});
	afterEach(async () => {
		await resetSandboxStateForTests();
		if (agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = agentDir;
		await recycleFixture(base);
	});
	it("probes actual runtime support and reports a reason when unavailable", async () => {
		expect(sandboxSupported()).toBe(false);
		const supported = await probeSandboxSupport();
		expect(supported).toBe(await probeSandboxSupport());
		expect(sandboxSupported()).toBe(supported);
		expect(sandboxCapability().available).toBe(supported);
		if (!supported) expect(sandboxCapability().unsupportedReason).toBeTruthy();
	});
	it("reuses only an identical session/cwd/roots/shell configuration", async (ctx) => {
		if (!(await probeSandboxSupport())) ctx.skip(sandboxCapability().unsupportedReason);
		const first = await sandboxFor("session-a", workspace, { mode: "workspace" });
		expect(first).not.toBeNull();
		expect(await sandboxFor("session-a", workspace, { mode: "workspace" })).toBe(first);
		expect(hasSandbox("session-a")).toBe(true);
		const extra = path.join(base, "extra"); await fs.mkdir(extra);
		const withExtra = await sandboxFor("session-a", workspace, { mode: "workspace", extraRoots: [extra] });
		expect(withExtra).not.toBe(first);
		expect(withExtra!.tempDir).not.toBe(first!.tempDir);
		const differentCwd = await sandboxFor("session-a", extra, { mode: "workspace" });
		expect(differentCwd).not.toBe(first);
		await releaseSandbox("session-a");
		expect(hasSandbox("session-a")).toBe(false);
	});
	it("gives readonly its readable workspace while denying file writes", async (ctx) => {
		if (!(await probeSandboxSupport())) ctx.skip(sandboxCapability().unsupportedReason);
		await fs.writeFile(path.join(workspace, "source.txt"), "visible");
		const holder = await sandboxFor("readonly", workspace, { mode: "readonly" });
		expect(holder).not.toBeNull();
		const result = await holder!.sandbox.runNode('module.exports=()=>require("node:fs").readFileSync("source.txt","utf8");', null, { cwd: workspace });
		expect(result.exitCode).toBe(0); expect(result.output).toBe("visible");
		expect((await holder!.sandbox.exec("echo blocked>blocked.txt", { cwd: workspace })).exitCode).not.toBe(0);
	});
	it("does not remove a replacement instance's scratch while an older release finishes", async (ctx) => {
		if (!(await probeSandboxSupport())) ctx.skip(sandboxCapability().unsupportedReason);
		const first = await sandboxFor("reopen", workspace, { mode: "workspace" });
		expect(first).not.toBeNull();
		const releasing = releaseSandbox("reopen");
		const second = await sandboxFor("reopen", workspace, { mode: "workspace" });
		await releasing;
		expect(second).not.toBeNull(); expect(second).not.toBe(first);
		expect(second!.tempDir).not.toBe(first!.tempDir);
		await expect(fs.access(second!.tempDir)).resolves.toBeUndefined();
		expect((await second!.sandbox.exec("echo alive", { cwd: workspace })).exitCode).toBe(0);
	});
	it("disposes a creation that was invalidated while it was pending", async (ctx) => {
		if (!(await probeSandboxSupport())) ctx.skip(sandboxCapability().unsupportedReason);
		const old = sandboxFor("pending", workspace, { mode: "workspace" });
		const release = releaseSandbox("pending");
		const fresh = sandboxFor("pending", workspace, { mode: "workspace" });
		expect(await old).toBeNull();
		await release;
		expect(await fresh).not.toBeNull();
		expect(hasSandbox("pending")).toBe(true);
	});
	it("awaits an already-started release after its holder has left the pool", async (ctx) => {
		if (!(await probeSandboxSupport())) ctx.skip(sandboxCapability().unsupportedReason);
		const holder = await sandboxFor("join-release", workspace, { mode: "workspace" });
		expect(holder).not.toBeNull();
		let finish!: () => void;
		const gate = new Promise<void>((resolve) => { finish = resolve; });
		const dispose = holder!.sandbox.dispose.bind(holder!.sandbox);
		const spy = vi.spyOn(holder!.sandbox, "dispose").mockImplementation(async () => { await gate; await dispose(); });
		const first = releaseSandbox("join-release");
		let joined = false;
		const second = releaseSandbox("join-release").then(() => { joined = true; });
		try {
			await Promise.resolve(); await Promise.resolve();
			expect(hasSandbox("join-release")).toBe(false);
			expect(joined).toBe(false);
		} finally { finish(); await Promise.all([first, second]); spy.mockRestore(); }
		await expect(fs.access(holder!.tempDir)).rejects.toMatchObject({ code: "ENOENT" });
	});
});
