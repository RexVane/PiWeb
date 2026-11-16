import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async (original) => ({ ...await original<typeof import("node:child_process")>(), spawn: mocks.spawn }));

import { runCommand, terminateProcessTree } from "../scripts/process-runner.mjs";
import { browserLaunchSpec } from "../scripts/launcher.mjs";
import { npmCliCandidates, npmCommand } from "../scripts/npm-command.mjs";
import { recycleFixture } from "./lib/sandbox/fixtures";

function fakeChild(pid = 12345) {
	return Object.assign(new EventEmitter(), {
		pid,
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		kill: vi.fn((_signal?: string) => true),
	});
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); mocks.spawn.mockReset(); });

describe("update command runner without real subprocesses", () => {
	it("imports all launcher/release entrypoints without spawning anything", async () => {
		await import("../scripts/entrypoint.mjs");
		await import("../bin/piweb.js");
		await import("../scripts/dev.mjs");
		await import("../scripts/release.mjs");
		expect(mocks.spawn).not.toHaveBeenCalled();
	});

	it("opens a reused instance with the native platform command without an optional package", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-launcher-open-"));
		try {
			await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "pi-web" }));
			// Mark it as a development checkout so the launcher does not try to prepare an
			// install-time production build (that path needs real dependencies).
			await fs.mkdir(path.join(root, "node_modules", "vitest"), { recursive: true });
			await fs.writeFile(path.join(root, "node_modules", "vitest", "package.json"), "{}");
			const child = Object.assign(fakeChild(), { unref: vi.fn() });
			mocks.spawn.mockImplementation(() => {
				if (process.platform === "win32") queueMicrotask(() => child.emit("close", 0));
				return child;
			});
			const { runLauncher } = await import("../scripts/launcher.mjs");
			const result = await runLauncher({
				root, args: [], env: { PI_CODING_AGENT_DIR: root },
				// readLaunchToken 必须注入：真实实现会去读本机 agent 目录里那个实例留下的令牌文件，
				// 于是"本机此刻有没有在跑带认证的 PiWeb"会决定这个用例开的是裸地址还是登录链接 —— 用例就不再 hermetic。
				dependencies: { probePort: async () => "busy", isPiWebRunning: async () => true, log: vi.fn(), readLaunchToken: () => null },
			});
			const url = "http://127.0.0.1:30141";
			const { command, args, env } = browserLaunchSpec(url);
			expect(result).toBe(0);
			expect(mocks.spawn).toHaveBeenCalledExactlyOnceWith(command, args, { env, detached: process.platform !== "win32", stdio: "ignore", windowsHide: true });
			if (process.platform !== "win32") expect(child.unref).toHaveBeenCalledOnce();
		} finally { await recycleFixture(root); }
	});

	it("avoids Windows DETACHED_PROCESS and waits cleanly for PowerShell Start-Process before exiting", async () => {
		vi.useFakeTimers();
		const { openBrowser } = await import("../scripts/launcher.mjs");
		const winChild = Object.assign(fakeChild(), { unref: vi.fn() });
		mocks.spawn.mockReturnValueOnce(winChild);
		let resolved = false;
		const winTask = openBrowser("http://127.0.0.1:30141", "win32").then(() => { resolved = true; });
		expect(mocks.spawn).toHaveBeenCalledWith("powershell.exe", expect.any(Array), expect.objectContaining({ detached: false, stdio: "ignore", windowsHide: true }));
		await Promise.resolve();
		expect(resolved).toBe(false);
		winChild.emit("close", 0);
		await winTask;
		expect(resolved).toBe(true);

		const hungChild = Object.assign(fakeChild(), { unref: vi.fn() });
		mocks.spawn.mockReturnValueOnce(hungChild);
		const timeoutTask = openBrowser("http://127.0.0.1:30141", "win32");
		await vi.advanceTimersByTimeAsync(5_000);
		await timeoutTask;
		expect(hungChild.unref).toHaveBeenCalledOnce();

		const linuxChild = Object.assign(fakeChild(), { unref: vi.fn() });
		mocks.spawn.mockReturnValueOnce(linuxChild);
		await openBrowser("http://127.0.0.1:30141", "linux");
		expect(mocks.spawn).toHaveBeenLastCalledWith("xdg-open", ["http://127.0.0.1:30141"], expect.objectContaining({ detached: true, stdio: "ignore", windowsHide: true }));
		expect(linuxChild.unref).toHaveBeenCalledOnce();
	});

	it("uses fixed argv and cwd, waits for close and bounds captured output", async () => {
		const child = fakeChild();
		mocks.spawn.mockReturnValue(child);
		const task = runCommand("git", ["pull", "--ff-only", "origin", "main"], { cwd: "/temporary/install", env: {} });
		expect(mocks.spawn).toHaveBeenCalledWith("git", ["pull", "--ff-only", "origin", "main"], expect.objectContaining({
			cwd: "/temporary/install", env: {}, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
		}));
		let done = false;
		void task.then(() => { done = true; });
		child.stdout.write("x".repeat(300 * 1024));
		child.emit("exit", 0);
		await Promise.resolve();
		expect(done).toBe(false);
		child.emit("close", 0);
		expect((await task).length).toBe(256 * 1024);
	});

	it("runs npm JavaScript directly and reports failed exit statuses", async () => {
		const child = fakeChild();
		mocks.spawn.mockReturnValue(child);
		const task = runCommand("npm", ["run", "check"], { cwd: "/temporary/install", env: {} });
		const failure = expect(task).rejects.toThrow("build failed");
		try {
			const invocation = npmCommand(["run", "check"], {});
			expect(mocks.spawn.mock.calls[0][0]).toBe(invocation.command);
			expect(mocks.spawn.mock.calls[0][1]).toEqual(invocation.args);
			child.stderr.write("build failed");
			child.emit("close", 1);
			await failure;
		} catch (error) {
			// E-7: observe the rejection assertion even when a setup step throws first,
			// otherwise the unawaited `rejects` promise masks the real failure.
			await failure.catch(() => {});
			throw error;
		}
	});
	it("finds npm in the Windows and POSIX Node installation layouts", () => {
		// Official Windows install: <nodeDir>/node_modules/npm/bin/npm-cli.js.
		const windowsPrefix = path.resolve(path.sep, "custom-node");
		expect(npmCliCandidates(path.join(windowsPrefix, "node.exe"), {})).toContain(path.join(windowsPrefix, "node_modules", "npm", "bin", "npm-cli.js"));
		// setup-node / nvm / Homebrew: <prefix>/bin/node with npm at <prefix>/lib/node_modules.
		const posixPrefix = path.resolve(path.sep, "opt", "hostedtoolcache", "node", "22.19.0", "x64");
		expect(npmCliCandidates(path.join(posixPrefix, "bin", "node"), {})).toContain(path.join(posixPrefix, "lib", "node_modules", "npm", "bin", "npm-cli.js"));
		// A PATH entry that is itself a Node prefix is searched both ways.
		const pathBin = path.resolve(path.sep, "custom", "bin");
		const fromPath = npmCliCandidates(path.join(windowsPrefix, "node.exe"), { PATH: pathBin });
		expect(fromPath).toContain(path.join(pathBin, "node_modules", "npm", "bin", "npm-cli.js"));
		expect(fromPath).toContain(path.resolve(pathBin, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"));
	});
	it.skipIf(process.platform !== "win32")("reports a failed process-tree termination instead of claiming every descendant stopped", async () => {
		const child = fakeChild(12345), killer = fakeChild(67890);
		mocks.spawn.mockReturnValue(killer);
		const stopped = expect(terminateProcessTree(child)).rejects.toThrow(/could not be confirmed stopped/);
		killer.emit("close", 1); await stopped;
		expect(child.kill).toHaveBeenCalledOnce();
	});

	it("terminates only its spawned process tree on timeout before rejecting", async () => {
		vi.useFakeTimers();
		const child = fakeChild(12345);
		const killer = fakeChild(67890);
		mocks.spawn.mockReturnValueOnce(child).mockReturnValueOnce(killer);
		const kill = vi.spyOn(process, "kill").mockReturnValue(true);
		const task = runCommand("npm", ["run", "check"], { cwd: "/temporary/install", timeoutMs: 100 });
		const failed = expect(task).rejects.toThrow(/timeout after/);
		await vi.advanceTimersByTimeAsync(100);
		if (process.platform === "win32") {
			expect(mocks.spawn).toHaveBeenLastCalledWith("taskkill", ["/PID", "12345", "/T", "/F"], { stdio: "ignore", windowsHide: true });
			killer.emit("close", 0);
		} else {
			expect(kill).toHaveBeenCalledWith(-12345, "SIGKILL");
		}
		await failed;
		child.emit("close", 0);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("cleans timeout state on spawn error and never spawns when already cancelled", async () => {
		vi.useFakeTimers();
		const child = fakeChild();
		mocks.spawn.mockReturnValue(child);
		const task = runCommand("npm", ["run", "check"], { cwd: "/temporary/install" });
		const failed = expect(task).rejects.toThrow("spawn failed");
		child.emit("error", new Error("spawn failed"));
		await failed;
		expect(vi.getTimerCount()).toBe(0);
		mocks.spawn.mockClear();
		await expect(runCommand("npm", ["run", "check"], { cwd: "/temporary/install", signal: AbortSignal.abort() })).rejects.toThrow(/cancelled/);
		expect(mocks.spawn).not.toHaveBeenCalled();
	});
});
