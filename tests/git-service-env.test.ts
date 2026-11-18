/**
 * A6/G3：git 子进程不再整体继承 `process.env`。
 * git-service 与 growth-service 都必须经 `child-process-env.gitEnv()` 起子进程：
 * 启动令牌/provider key 等凭据变量、父进程注入的 GIT_DIR/GIT_INDEX_FILE 不能进入子进程，
 * 而 PATH/HOME 与 git 必需的覆盖值必须保留。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recycleFixture } from "./fixtures/recycle";

const captured = vi.hoisted(() => ({
	calls: [] as Array<{ command: string; env: Record<string, string | undefined> }>,
}));

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	type Options = Record<string, unknown>;
	return {
		...actual,
		spawn: (command: string, args?: readonly string[], options?: Options) => {
			captured.calls.push({ command, env: (options?.env ?? {}) as Record<string, string | undefined> });
			return (actual.spawn as (...values: unknown[]) => unknown)(command, args, options);
		},
		execFile: (file: string, args?: readonly string[], options?: Options | ((error: unknown, stdout: string, stderr: string) => void), callback?: unknown) => {
			const opts = typeof options === "function" ? undefined : options;
			const cb = typeof options === "function" ? options : callback;
			captured.calls.push({ command: file, env: (opts?.env ?? {}) as Record<string, string | undefined> });
			return (actual.execFile as (...values: unknown[]) => unknown)(file, args, opts, cb);
		},
	};
});

import { repoRoot } from "@/lib/git-service";
import { isAvailable } from "@/lib/growth-service";

const SECRET_KEYS = ["PI_WEB_LAUNCH_TOKEN", "PIWEB_TEST_API_KEY", "PROVIDER_SECRET", "SOME_PASSWORD"] as const;
const GIT_SESSION_KEYS = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_CONFIG_COUNT"] as const;
const previous: Record<string, string | undefined> = {};
let directory: string;

function findEnv(name: string): string | undefined {
	for (const call of captured.calls) {
		for (const [key, value] of Object.entries(call.env)) {
			if (key.toLowerCase() === name.toLowerCase()) return value;
		}
	}
	return undefined;
}

function envKeys(): Set<string> {
	const keys = new Set<string>();
	for (const call of captured.calls) for (const key of Object.keys(call.env)) keys.add(key.toLowerCase());
	return keys;
}

beforeEach(async () => {
	captured.calls.length = 0;
	for (const key of [...SECRET_KEYS, ...GIT_SESSION_KEYS]) previous[key] = process.env[key];
	process.env.PI_WEB_LAUNCH_TOKEN = "launch-token-must-not-leak";
	process.env.PIWEB_TEST_API_KEY = "provider-key-must-not-leak";
	process.env.PROVIDER_SECRET = "secret-must-not-leak";
	process.env.SOME_PASSWORD = "password-must-not-leak";
	process.env.GIT_DIR = "C:\\elsewhere\\.git";
	process.env.GIT_WORK_TREE = "C:\\elsewhere";
	process.env.GIT_INDEX_FILE = "C:\\elsewhere\\index";
	process.env.GIT_CONFIG_COUNT = "1";
	directory = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-git-env-"));
});

afterEach(async () => {
	for (const [key, value] of Object.entries(previous)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	vi.restoreAllMocks();
	await recycleFixture(directory).catch(() => undefined);
});

describe("git-service subprocess environment", () => {
	it("does not forward credentials or inherited GIT_* session variables", async () => {
		// 非仓库目录也会起 git rev-parse：env 已经传进 spawn/execFile。
		// 这里只关心传给子进程的环境；git 退出码（非仓库）不影响断言。
		await repoRoot(directory).catch(() => undefined);
		expect(captured.calls.length).toBeGreaterThan(0);
		const keys = envKeys();
		for (const key of [...SECRET_KEYS, ...GIT_SESSION_KEYS]) expect(keys.has(key.toLowerCase()), key).toBe(false);
		expect(findEnv("PATH")).toBeTruthy();
		// git 必需的覆盖值仍然在
		expect(findEnv("GIT_OPTIONAL_LOCKS")).toBe("0");
		expect(findEnv("GIT_TERMINAL_PROMPT")).toBe("0");
		expect(findEnv("LC_ALL")).toBe("C");
	});
});

describe("growth-service subprocess environment", () => {
	it("runs git --version with the scrubbed environment", async () => {
		await expect(isAvailable()).resolves.toBe(true);
		expect(captured.calls.length).toBeGreaterThan(0);
		const keys = envKeys();
		for (const key of [...SECRET_KEYS, ...GIT_SESSION_KEYS]) expect(keys.has(key.toLowerCase()), key).toBe(false);
		expect(findEnv("PATH")).toBeTruthy();
		expect(findEnv("GIT_TERMINAL_PROMPT")).toBe("0");
	});
});
