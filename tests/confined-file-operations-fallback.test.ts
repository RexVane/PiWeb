/**
 * 没有受限后端的平台（macOS 等）：工作区内修改档靠路径级检查写文件，而不是一律拒绝。
 * Windows 的原生目录保护不可用时仍然拒绝，不退化成路径级写入。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recycleFixture } from "./lib/sandbox/fixtures";

const sandboxFor = vi.fn(async () => null);
vi.mock("@/lib/sandbox/manager", () => ({ sandboxFor }));
vi.mock("@/lib/sandbox/windows-file-operations", () => ({ windowsFileOperation: vi.fn(async () => { throw new Error("Protected file writes are unavailable. Reinstall PiWeb's optional native dependency (koffi) and retry; no file was changed."); }) }));
vi.mock("@/lib/sandbox/config", () => ({ readSandboxConfig: vi.fn(async () => ({ additionalWritableRoots: [] })) }));

const { createConfinedFileOperations } = await import("@/lib/confined-file-operations");

describe("confined file operations without an OS backend", () => {
	const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
	let base: string;
	let workspace: string;

	beforeEach(async () => {
		base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "piweb-confined-fallback-")));
		workspace = path.join(base, "workspace");
		await fs.mkdir(workspace);
		sandboxFor.mockClear();
	});
	afterEach(async () => {
		Object.defineProperty(process, "platform", platform);
		await recycleFixture(base);
	});
	const as = (value: string) => Object.defineProperty(process, "platform", { ...platform, value });

	it("writes inside the workspace on a platform with neither backend", async () => {
		as("darwin");
		const operations = createConfinedFileOperations({ sessionPath: "fallback", cwd: workspace, preset: () => "workspace" });
		await operations.mkdir(path.join(workspace, "nested"));
		const target = path.join(workspace, "nested", "new.txt");
		await operations.writeFile(target, "first");
		await operations.writeFile(target, "replacement");
		expect(await fs.readFile(target, "utf8")).toBe("replacement");
		expect(await fs.readdir(path.dirname(target))).toEqual(["new.txt"]);
		expect(sandboxFor).not.toHaveBeenCalled();
	});

	it("still refuses targets outside the workspace and hard-linked targets", async () => {
		as("darwin");
		const operations = createConfinedFileOperations({ sessionPath: "fallback", cwd: workspace, preset: () => "workspace" });
		const outside = path.join(base, "outside.txt");
		await fs.writeFile(outside, "keep");
		await expect(operations.writeFile(outside, "changed")).rejects.toThrow("outside the active workspace boundary");
		const alias = path.join(workspace, "alias.txt");
		await fs.link(outside, alias);
		await expect(operations.writeFile(alias, "changed")).rejects.toThrow(/blocked/);
		expect(await fs.readFile(outside, "utf8")).toBe("keep");
	});

	it("keeps failing closed on Windows when native directory protection is unavailable", async () => {
		as("win32");
		const operations = createConfinedFileOperations({ sessionPath: "fallback", cwd: workspace, preset: () => "workspace" });
		const target = path.join(workspace, "new.txt");
		await expect(operations.writeFile(target, "x")).rejects.toThrow("Reinstall PiWeb's optional native dependency (koffi)");
		await expect(fs.access(target)).rejects.toMatchObject({ code: "ENOENT" });
	});
});
