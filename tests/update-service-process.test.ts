import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));

import { runCommand } from "../scripts/process-runner.mjs";

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
			mocks.spawn.mockReturnValue(child);
			const { runLauncher } = await import("../scripts/launcher.mjs");
			const result = await runLauncher({
				root, args: [], env: {},
				dependencies: { probePort: async () => "busy", isPiWebRunning: async () => true, log: vi.fn() },
			});
			const url = "http://127.0.0.1:30141";
			const command = process.platform === "win32" ? "cmd.exe" : process.platform === "darwin" ? "open" : "xdg-open";
			const args = process.platform === "win32" ? ["/d", "/c", "start", "", url] : [url];
			expect(result).toBe(0);
			expect(mocks.spawn).toHaveBeenCalledExactlyOnceWith(command, args, { detached: true, stdio: "ignore", windowsHide: true });
			expect(child.unref).toHaveBeenCalledOnce();
		} finally { await fs.rm(root, { recursive: true, force: true }); }
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

	it("only uses the Windows command shim for npm and reports failed exit statuses", async () => {
		const child = fakeChild();
		mocks.spawn.mockReturnValue(child);
		const task = runCommand("npm", ["run", "check"], { cwd: "/temporary/install", env: {} });
		const failure = expect(task).rejects.toThrow("build failed");
		if (process.platform === "win32") {
			expect(mocks.spawn.mock.calls[0][0]).toBe("cmd.exe");
			expect(mocks.spawn.mock.calls[0][1]).toEqual(["/d", "/c", "npm", "run", "check"]);
		} else {
			expect(mocks.spawn.mock.calls[0][0]).toBe("npm");
			expect(mocks.spawn.mock.calls[0][1]).toEqual(["run", "check"]);
		}
		child.stderr.write("build failed");
		child.emit("close", 1);
		await failure;
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
