/**
 * L5/L6 优雅停机：
 * - process-runner：先请求子进程自行收尾，超时才强杀进程树（Windows 用 taskkill /T，兜底 /T /F）；
 * - graceful-shutdown：注册/执行停机钩子（LIFO、超时、失败隔离）、退出码保持 Node 原生约定；
 * - launcher：SIGINT/SIGTERM 不再直接强杀；由信号发起的关闭仍以非 0 退出（约定不变）；
 * - F1：launcher 不再用 `x-piweb-warmup` 伪造请求换 Cookie。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { recycleFixture } from "./lib/sandbox/fixtures";

const killerCalls = vi.hoisted(() => [] as string[][]);

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		spawn: (command: string, args?: readonly string[], options?: Record<string, unknown>) => {
			if (command === "taskkill") {
				killerCalls.push([...(args ?? [])]);
				const killer = new EventEmitter() as EventEmitter & { kill: () => void };
				killer.kill = () => undefined;
				setImmediate(() => killer.emit("close", (args ?? []).includes("/F") ? 0 : 128));
				return killer;
			}
			return (actual.spawn as (...values: unknown[]) => unknown)(command, args, options);
		},
	};
});

import { gracefulStopTimeoutMs, terminateProcessTreeGracefully } from "../scripts/process-runner.mjs";
import { runLauncher, warmFirstPaint } from "../scripts/launcher.mjs";
import { getRegisteredShutdownHooks, installGracefulShutdown, registerShutdownHook, runShutdownHooks, shutdownExitCode, shutdownTimeoutMs } from "../src/lib/graceful-shutdown";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.unstubAllEnvs();
	killerCalls.length = 0;
});

function fakeChild({ pid = 4321, exitAfterMs, exitCode = 130 }: { pid?: number; exitAfterMs?: number; exitCode?: number } = {}) {
	const child = Object.assign(new EventEmitter(), {
		pid,
		exitCode: null as number | null,
		signalCode: null as string | null,
		kill: vi.fn(() => true),
	});
	if (exitAfterMs !== undefined) {
		setTimeout(() => { child.exitCode = exitCode; child.emit("exit", exitCode); }, exitAfterMs).unref?.();
	}
	return child;
}

describe("terminateProcessTreeGracefully", () => {
	it("waits for the child to stop before force-killing the tree", async () => {
		const child = fakeChild({ exitAfterMs: 20 });
		// POSIX signals the child's process group. There is no real group for the fake
		// pid, so intercept it: the real kill would ESRCH into the child-level fallback.
		const groupKill = vi.spyOn(process, "kill").mockReturnValue(true);
		let groupKillArgs: unknown[][] = [];
		try {
			await terminateProcessTreeGracefully(child, { timeoutMs: 500 });
			groupKillArgs = groupKill.mock.calls.slice();
		} finally {
			groupKill.mockRestore();
		}
		if (process.platform === "win32") {
			expect(child.kill).not.toHaveBeenCalled();
			expect(killerCalls.length).toBeGreaterThan(0);
			expect(killerCalls.every((args) => !args.includes("/F"))).toBe(true);
		} else {
			// Catchable SIGTERM to the group; a child that exits inside the grace window
			// is never force-killed (no SIGKILL and no direct child.kill fallback).
			// Assert on captured calls: mockRestore() resets the spy's call history.
			expect(groupKillArgs).toContainEqual([-4321, "SIGTERM"]);
			expect(child.kill).not.toHaveBeenCalled();
		}
	});

	it("falls back to the forced tree kill when the grace window expires", async () => {
		const child = fakeChild();
		const groupKill = vi.spyOn(process, "kill").mockImplementation(() => {
			throw Object.assign(new Error("ESRCH: no such process group"), { code: "ESRCH" });
		});
		try {
			await terminateProcessTreeGracefully(child, { timeoutMs: 40 });
		} finally {
			groupKill.mockRestore();
		}
		if (process.platform === "win32") {
			expect(killerCalls.some((args) => args.includes("/F"))).toBe(true);
		} else {
			// POSIX 先 SIGTERM（可捕获），超时后 SIGKILL 进程组。
			expect(child.kill).toHaveBeenCalledWith("SIGTERM");
			expect(child.kill).toHaveBeenCalledWith("SIGKILL");
		}
	});

	it("returns immediately for an already exited child and reads the timeout from env", async () => {
		const child = Object.assign(fakeChild(), { exitCode: 0 });
		await terminateProcessTreeGracefully(child);
		expect(child.kill).not.toHaveBeenCalled();
		expect(killerCalls).toEqual([]);
		vi.stubEnv("PIWEB_GRACEFUL_STOP_TIMEOUT_MS", "1234");
		expect(gracefulStopTimeoutMs()).toBe(1234);
		// HMR/测试残留的环境变量不合法时回退默认值。
		vi.stubEnv("PIWEB_GRACEFUL_STOP_TIMEOUT_MS", "-5");
		expect(gracefulStopTimeoutMs()).toBe(10_000);
	});
});

describe("graceful shutdown hooks", () => {
	it("runs hooks in LIFO order, replaces duplicate names and isolates failures", async () => {
		const order: string[] = [];
		const first = registerShutdownHook(() => { order.push("first"); }, { name: "unit-first" });
		const stale = registerShutdownHook(() => { order.push("stale"); }, { name: "unit-second" });
		registerShutdownHook(() => { order.push("second"); }, { name: "unit-second" });
		registerShutdownHook(() => { throw new Error("fixture hook failure"); }, { name: "unit-failing" });
		expect(getRegisteredShutdownHooks()).toEqual(expect.arrayContaining(["unit-first", "unit-second", "unit-failing"]));
		expect(getRegisteredShutdownHooks().filter((name) => name === "unit-second")).toHaveLength(1);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		await runShutdownHooks("unit-test");
		warn.mockRestore();
		expect(order).toEqual(["second", "first"]);
		expect(stale).toBeTypeOf("function");
		first();
		// 同名钩子只保留最新实现：注销旧的不会误删新的。
		expect(getRegisteredShutdownHooks()).not.toContain("unit-first");
	});

	it("bounds the total budget and reports hooks that did not finish", async () => {
		vi.stubEnv("PIWEB_SHUTDOWN_TIMEOUT_MS", "30");
		expect(shutdownTimeoutMs()).toBe(30);
		registerShutdownHook(() => new Promise(() => undefined), { name: "unit-hung" });
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const started = Date.now();
		await runShutdownHooks("unit-timeout");
		warn.mockRestore();
		expect(Date.now() - started).toBeLessThan(2_000);
	});

	it("keeps Node's native exit code convention", () => {
		expect(shutdownExitCode("SIGINT")).toBe(130);
		expect(shutdownExitCode("SIGTERM")).toBe(143);
		expect(shutdownExitCode("SIGHUP")).toBe(129);
	});

	it("installs signal handlers only outside the test process by default", () => {
		const before = process.listenerCount("SIGTERM");
		installGracefulShutdown();
		// VITEST 进程不接管信号：vitest 结束 worker 的 SIGTERM 不能被停机预算拖住。
		expect(process.listenerCount("SIGTERM")).toBe(before);
	});
});

describe("launcher graceful stop", () => {
	async function installation() {
		const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "piweb-graceful-")));
		cleanups.push(() => recycleFixture(root));
		await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "pi-web", version: "1.0.0" }));
		await fs.mkdir(path.join(root, "node_modules", "vitest"), { recursive: true });
		await fs.writeFile(path.join(root, "node_modules", "vitest", "package.json"), "{}");
		return root;
	}

	it("waits for the child on SIGINT, then preserves the non-zero signal exit convention", async () => {
		const root = await installation();
		const child = fakeChild({ pid: 6100 });
		let spawnCalls = 0;
		const before = new Set(process.listeners("SIGINT"));
		// POSIX forwards a catchable SIGTERM to the child's process group; there is no
		// real group for the fake pid, so intercept the group signal instead of allowing
		// a real ESRCH to fall back to a direct child.kill.
		const groupKill = vi.spyOn(process, "kill").mockReturnValue(true);
		try {
			const running = runLauncher({
				root,
				args: ["--dev", "--no-open"],
				env: {},
				dependencies: {
					spawn: vi.fn(() => { spawnCalls += 1; return child; }),
					probePort: vi.fn(async () => "free"),
					isPiWebRunning: vi.fn(async () => true),
					warmFirstPaint: vi.fn(async () => true),
					log: vi.fn(),
				},
			});
			await vi.waitFor(() => expect(process.listeners("SIGINT").some((listener) => !before.has(listener))).toBe(true));
			const handler = process.listeners("SIGINT").find((listener) => !before.has(listener))!;
			handler("SIGINT" as never);
			setTimeout(() => { child.exitCode = 130; child.emit("exit", 130); }, 20);
			await expect(running).resolves.toBe(1);
			expect(spawnCalls).toBe(1);
			if (process.platform === "win32") {
				expect(child.kill).not.toHaveBeenCalled();
				expect(killerCalls.every((args) => !args.includes("/F"))).toBe(true);
			} else {
				expect(groupKill).toHaveBeenCalledWith(-6100, "SIGTERM");
				expect(child.kill).not.toHaveBeenCalled();
			}
			// 收尾后信号监听器必须摘掉，重复运行不会叠加处理器。
			expect(process.listeners("SIGINT").some((listener) => !before.has(listener))).toBe(false);
		} finally {
			groupKill.mockRestore();
		}
	});

	it("no longer mints a session cookie through x-piweb-warmup (F1)", async () => {
		const requests: Array<{ path: string; warmup: string | null }> = [];
		const fetchImpl: typeof fetch = async (input, init) => {
			const url = new URL(String(input));
			requests.push({ path: url.pathname, warmup: new Headers(init?.headers).get("x-piweb-warmup") });
			if (url.pathname === "/api/sessions") return new Response("authentication required", { status: 401 });
			return new Response("{}", { status: 200 });
		};
		expect(await warmFirstPaint("http://127.0.0.1:30141", { fetchImpl, check: async () => true })).toBe(false);
		expect(requests.some((request) => request.warmup === "1")).toBe(false);
		expect(requests.some((request) => request.path === "/")).toBe(false);
		// 首屏其余路由照旧预热（失败不阻止启动）。
		expect(requests.map((request) => request.path)).toContain("/api/version");
	});
});
