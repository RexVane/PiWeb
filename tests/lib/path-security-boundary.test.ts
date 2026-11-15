/**
 * 路径边界（D1/G1）：
 * - D1：`path-boundary` 是叶子模块，`jsonc-settings-storage` 不再经由 `path-security` 回连 `pi`；
 * - G1：`PIWEB_FS_STRICT_WORKSPACES=1` 时工作区必须位于已注册工作区或显式允许根内，
 *   默认关闭时必须保持原有「任意现存目录」行为。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BoundaryError, isPathInside, resolveWorkspacePath, samePath, strictWorkspaceModeEnabled } from "@/lib/path-security";
import { addWorkspace } from "@/lib/workspace-store";
import { recycleTemporaryDirectory } from "@/lib/recycle-temporary";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const ENV_KEYS = ["PIWEB_FS_STRICT_WORKSPACES", "PIWEB_FS_ALLOWED_ROOTS", "PI_CODING_AGENT_DIR"] as const;

let previous: Record<string, string | undefined>;
let root: string;

beforeEach(async () => {
	previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
	root = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-path-boundary-"));
	process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
	delete process.env.PIWEB_FS_STRICT_WORKSPACES;
	delete process.env.PIWEB_FS_ALLOWED_ROOTS;
});

afterEach(async () => {
	for (const key of ENV_KEYS) {
		if (previous[key] === undefined) delete process.env[key];
		else process.env[key] = previous[key];
	}
	vi.restoreAllMocks();
	await recycleTemporaryDirectory(root).catch(() => undefined);
});

describe("path boundary helpers", () => {
	it("compares normalized paths instead of string prefixes", () => {
		expect(isPathInside("C:\\work\\app", "C:\\work\\app\\src\\..\\file.ts")).toBe(true);
		expect(isPathInside("C:\\work\\app", "C:\\work\\application\\x")).toBe(false);
		expect(samePath("C:\\work\\app", "C:/work/app/")).toBe(true);
	});
});

describe("workspace resolution keeps its default permissive behavior (G1)", () => {
	it("accepts any existing directory when strict mode is off", async () => {
		const directory = path.join(root, "unregistered");
		await fs.mkdir(directory);
		expect(strictWorkspaceModeEnabled()).toBe(false);
		await expect(resolveWorkspacePath(directory)).resolves.toBe(await fs.realpath(directory));
	});

	it("rejects non-directories and missing paths as before", async () => {
		const file = path.join(root, "a.txt");
		await fs.writeFile(file, "x");
		await expect(resolveWorkspacePath(file)).rejects.toBeInstanceOf(BoundaryError);
		await expect(resolveWorkspacePath(path.join(root, "missing"))).rejects.toBeInstanceOf(BoundaryError);
	});
});

describe("opt-in strict workspaces (PIWEB_FS_STRICT_WORKSPACES=1)", () => {
	beforeEach(() => { process.env.PIWEB_FS_STRICT_WORKSPACES = "1"; });

	it("allows directories under an explicitly configured root", async () => {
		const allowed = path.join(root, "allowed");
		const nested = path.join(allowed, "project");
		await fs.mkdir(nested, { recursive: true });
		process.env.PIWEB_FS_ALLOWED_ROOTS = allowed;
		await expect(resolveWorkspacePath(nested)).resolves.toBe(await fs.realpath(nested));
	});

	it("rejects an unregistered directory when a root allowlist is configured", async () => {
		const allowed = path.join(root, "allowed");
		const outside = path.join(root, "outside");
		await fs.mkdir(allowed);
		await fs.mkdir(outside);
		process.env.PIWEB_FS_ALLOWED_ROOTS = allowed;
		await expect(resolveWorkspacePath(outside)).rejects.toThrow(/not registered/);
	});

	it("allows directories inside a registered workspace, including nested ones", async () => {
		const workspace = path.join(root, "registered");
		const nested = path.join(workspace, "src");
		await fs.mkdir(nested, { recursive: true });
		await addWorkspace(workspace);
		const outside = path.join(root, "outside");
		await fs.mkdir(outside);
		await expect(resolveWorkspacePath(workspace)).resolves.toBe(await fs.realpath(workspace));
		await expect(resolveWorkspacePath(nested)).resolves.toBe(await fs.realpath(nested));
		await expect(resolveWorkspacePath(outside)).rejects.toThrow(/not registered/);
	});
});

describe("import graph has no pi → jsonc → path-security → pi cycle (D1)", () => {
	async function source(...segments: string[]): Promise<string> {
		return fs.readFile(path.join(REPO_ROOT, "src", "lib", ...segments), "utf8");
	}

	it("jsonc-settings-storage imports the leaf boundary module, not path-security", async () => {
		const jsonc = await source("jsonc-settings-storage.ts");
		expect(jsonc).toContain('from "./path-boundary"');
		expect(jsonc).not.toContain('from "./path-security"');
	});

	it("path-boundary stays a leaf module", async () => {
		const boundary = await source("path-boundary.ts");
		expect(boundary).not.toMatch(/from "\.\/(?:pi|path-security|jsonc-settings-storage)"/);
	});

	it("path-security re-exports the boundary helpers for existing importers", () => {
		expect(new BoundaryError("x")).toBeInstanceOf(Error);
		expect(typeof isPathInside).toBe("function");
		expect(typeof samePath).toBe("function");
	});
});
