import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 子进程 env 清洗：编辑器 spawn 不能继承 PiWeb 进程的启动令牌 / provider 密钥。
 * 用假的 spawn 截获真正传给编辑器的 options（真起 VS Code 不属于单测）。
 */
const spawns = vi.hoisted(() => [] as Array<{ command: string; args: string[]; options: Record<string, unknown> }>);

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	const fakeSpawn = (command: string, args: string[], options: Record<string, unknown> = {}) => {
		spawns.push({ command, args, options });
		const handlers = new Map<string, Array<(...input: unknown[]) => void>>();
		const child = {
			on(event: string, handler: (...input: unknown[]) => void) {
				const list = handlers.get(event) ?? [];
				list.push(handler);
				handlers.set(event, list);
				queueMicrotask(() => { if (event === "exit") for (const item of handlers.get("exit") ?? []) item(0, null); });
				return child;
			},
			unref: () => undefined,
		};
		return child;
	};
	return { ...actual, spawn: fakeSpawn };
});

import { openInEditor } from "../src/lib/files-service";

describe("openInEditor child process environment", () => {
	let root = "";
	const saved = { token: process.env.PI_WEB_LAUNCH_TOKEN, secret: process.env.PI_WEB_SECRET, editor: process.env.PI_WEB_EDITOR };

	beforeEach(async () => {
		root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "piweb-editor-env-")));
		await fs.writeFile(path.join(root, "file.txt"), "hello");
		spawns.length = 0;
		process.env.PI_WEB_LAUNCH_TOKEN = "launch-token-should-not-leak";
		process.env.PI_WEB_SECRET = "web-secret-should-not-leak";
		process.env.MY_SERVICE_API_KEY = "api-key-should-not-leak";
		delete process.env.PI_WEB_EDITOR;
	});

	afterEach(async () => {
		for (const [key, value] of [["PI_WEB_LAUNCH_TOKEN", saved.token], ["PI_WEB_SECRET", saved.secret], ["PI_WEB_EDITOR", saved.editor]] as const) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		delete process.env.MY_SERVICE_API_KEY;
		await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
	});

	it("spawns the editor without inheriting PiWeb secrets but keeps the normal environment", async () => {
		await openInEditor(root, "file.txt");
		expect(spawns).toHaveLength(1);
		const env = spawns[0].options.env as Record<string, string>;
		expect(env).toBeTypeOf("object");
		expect(env.PI_WEB_LAUNCH_TOKEN).toBeUndefined();
		expect(env.PI_WEB_SECRET).toBeUndefined();
		expect(env.MY_SERVICE_API_KEY).toBeUndefined();
		// PATH 之类正常变量必须保留，否则编辑器会启动失败
		expect(typeof env.PATH).toBe("string");
		if (process.platform === "win32") expect(env.ComSpec ?? env.COMSPEC).toBeTruthy();
		// PI_WEB_EDITOR 自己也属于下发配置，可以保留（它不敏感），但 spawn 用的是清洗后的副本
		expect(process.env.PI_WEB_LAUNCH_TOKEN).toBe("launch-token-should-not-leak");
	});

	it("honors PI_WEB_EDITOR and resolves the real file path", async () => {
		process.env.PI_WEB_EDITOR = "notepad";
		const result = await openInEditor(root, "file.txt");
		expect(result.editor).toBe("notepad");
		expect(result.target).toBe(await fs.realpath(path.join(root, "file.txt")));
		const last = spawns.at(-1)!;
		if (process.platform === "win32") {
			// Windows 下 code.cmd 之类必须经 cmd.exe 启动
			expect(last.command.toLowerCase()).toContain("cmd.exe");
			expect(last.args.slice(0, 3)).toEqual(["/d", "/c", "notepad"]);
		} else {
			expect(last.command).toBe("notepad");
		}
	});
});
