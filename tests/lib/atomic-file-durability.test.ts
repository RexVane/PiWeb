/**
 * 原子写持久性（D3）：rename 发布前后必须 fsync（数据 + 目录项），
 * 目录 fsync 在 Windows / 某些文件系统不可用时要安全降级而不是让写操作失败。
 */
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 记录同步写路径的 fsync 调用：jsonc 设置写的是同步路径，直接 spy node:fs 的具名导入
// 在 ESM 互操作下不可靠，改为包一层原子写模块的同步助手。
const syncCalls = vi.hoisted(() => ({ files: [] as string[], directories: [] as string[] }));
vi.mock("@/lib/atomic-file", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/atomic-file")>();
	return {
		...actual,
		syncFileSync: (file: string) => { syncCalls.files.push(file); return actual.syncFileSync(file); },
		syncDirectorySync: (directory: string) => { syncCalls.directories.push(directory); return actual.syncDirectorySync(directory); },
	};
});

import { replaceFileAtomically, syncDirectory, syncDirectorySync, syncFile, syncFileSync } from "@/lib/atomic-file";
import { mutateJsoncSettingsFileSync } from "@/lib/jsonc-settings-storage";
import { recycleTemporaryDirectory } from "@/lib/recycle-temporary";

let directory: string;
let source: string;
let destination: string;

beforeEach(async () => {
	directory = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-durable-write-"));
	source = path.join(directory, "pending");
	destination = path.join(directory, "current");
	await fs.writeFile(source, "new contents");
	await fs.writeFile(destination, "old contents");
});

afterEach(async () => {
	vi.restoreAllMocks();
	await recycleTemporaryDirectory(directory).catch(() => undefined);
});

async function fileHandlePrototype(): Promise<{ sync: () => Promise<void> }> {
	const handle = await fs.open(source, "r");
	try {
		return Object.getPrototypeOf(handle) as { sync: () => Promise<void> };
	} finally {
		await handle.close();
	}
}

describe("replaceFileAtomically durability", () => {
	it("fsyncs the payload and the destination directory around the rename", async () => {
		const prototype = await fileHandlePrototype();
		const sync = vi.spyOn(prototype, "sync");
		await replaceFileAtomically(source, destination);
		expect(await fs.readFile(destination, "utf8")).toBe("new contents");
		// 至少一次数据 fsync + 一次目录 fsync；顺序是先刷数据再 rename。
		expect(sync.mock.calls.length).toBeGreaterThanOrEqual(2);
	});

	it("still commits when the platform refuses directory fsync (EPERM/EINVAL)", async () => {
		const prototype = await fileHandlePrototype();
		// Windows 上只读目录句柄的 FlushFileBuffers 会 EPERM；这里让所有 sync 都不可用，
		// 断言写路径仍然成功（安全降级）。
		vi.spyOn(prototype, "sync").mockRejectedValue(Object.assign(new Error("operation not permitted"), { code: "EPERM" }));
		await replaceFileAtomically(source, destination);
		expect(await fs.readFile(destination, "utf8")).toBe("new contents");
	});

	it("propagates a real I/O failure from fsync instead of silently reporting success", async () => {
		const prototype = await fileHandlePrototype();
		vi.spyOn(prototype, "sync").mockRejectedValueOnce(Object.assign(new Error("input/output error"), { code: "EIO" }));
		await expect(replaceFileAtomically(source, destination)).rejects.toMatchObject({ code: "EIO" });
		// 数据还没发布：目标保留旧内容，临时文件还在（重试/清理交给调用方）。
		expect(await fs.readFile(destination, "utf8")).toBe("old contents");
		expect(await fs.readFile(source, "utf8")).toBe("new contents");
	});
});

describe("sync helpers", () => {
	it("flush a file and a directory without changing their contents", async () => {
		await syncFile(source);
		await syncDirectory(directory);
		expect(await fs.readFile(source, "utf8")).toBe("new contents");
		const probe = path.join(directory, "sync-probe");
		const fd = fsSync.openSync(probe, "wx", 0o600);
		try {
			fsSync.writeFileSync(fd, "x");
			fsSync.fsyncSync(fd);
		} finally {
			fsSync.closeSync(fd);
		}
		syncFileSync(probe);
		syncDirectorySync(directory);
		expect(await fs.readFile(probe, "utf8")).toBe("x");
	});

	it("degrades when a filesystem does not support fsync at all", async () => {
		const prototype = await fileHandlePrototype();
		vi.spyOn(prototype, "sync").mockRejectedValue(Object.assign(new Error("not supported"), { code: "ENOTSUP" }));
		await expect(syncFile(source)).resolves.toBeUndefined();
		await expect(syncDirectory(directory)).resolves.toBeUndefined();
	});
});

describe("settings writes are durable", () => {
	it("fsyncs the temporary settings file before publishing it", async () => {
		syncCalls.files.length = 0;
		syncCalls.directories.length = 0;
		const settings = path.join(directory, "settings.json");
		mutateJsoncSettingsFileSync(settings, (current) => ({ ...current, theme: "dark" }));
		// 发布前先刷临时文件的数据，发布后再刷目录项（目录不可用时安全降级）。
		expect(syncCalls.files.some((file) => file.startsWith(`${settings}.`) && file.endsWith(".tmp"))).toBe(true);
		expect(syncCalls.directories).toContain(directory);
		const written = JSON.parse(await fs.readFile(settings, "utf8")) as { theme?: string };
		expect(written.theme).toBe("dark");
		const leftovers = (await fs.readdir(directory)).filter((name) => name.includes(".tmp"));
		expect(leftovers).toEqual([]);
	});
});
