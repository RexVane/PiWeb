import fs from "node:fs/promises";
import { recycleGeneratedFixture } from "./fixtures/system-trash";
import { readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getSettingsManager: vi.fn(), getPackageManager: vi.fn(),
	reloadAllLoaders: vi.fn(async () => []), reloadSessionsForCwd: vi.fn(async () => 0),
	installAndPersist: vi.fn(), removeAndPersist: vi.fn(),
}));
vi.mock("../src/lib/pi", () => ({
	getAgentDir: () => process.env.PI_CODING_AGENT_DIR,
	getSettingsManager: mocks.getSettingsManager,
	getPackageManager: mocks.getPackageManager,
	reloadAllLoaders: mocks.reloadAllLoaders,
	resolveProjectTrust: () => ({ trusted: true }),
}));
vi.mock("../src/lib/agent-manager", () => ({ reloadSessionsForCwd: mocks.reloadSessionsForCwd }));

import { installPackage, listPackages, removePackage, toggleExtension, togglePackage } from "../src/lib/plugins-service";
import { POST } from "../src/app/api/plugins/route";

it("preserves unrelated settings and never overwrites a malformed file when toggling a package", async () => {
	const previous = process.env.PI_CODING_AGENT_DIR;
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-plugin-settings-"));
	const file = path.join(agentDir, "settings.json");
	try {
		process.env.PI_CODING_AGENT_DIR = agentDir;
		await fs.writeFile(file, JSON.stringify({ theme: "dark", packages: ["example-package"], retry: { maxRetries: 5 } }));
		mocks.getSettingsManager.mockReturnValue(SettingsManager.create(agentDir, agentDir));
		await togglePackage("example-package", true, "user", agentDir);
		expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({
			theme: "dark",
			packages: [],
			retry: { maxRetries: 5 },
			disabledPackages: ["example-package"],
		});

		await fs.writeFile(file, "{broken json");
		await expect(togglePackage("example-package", false, "user", agentDir)).rejects.toThrow();
		expect(await fs.readFile(file, "utf8")).toBe("{broken json");
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		await recycleGeneratedFixture(agentDir);
	}
});

describe("SDK package and extension persistence", () => {
	let agentDir: string;
	let cwd: string;
	let file: string;
	let projectFile: string;
	let manager: SettingsManager;
	let mode: "ok" | "deny" | "drop";

	beforeEach(async () => {
		agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-plugin-write-"));
		cwd = path.join(agentDir, "project");
		file = path.join(agentDir, "settings.json");
		projectFile = path.join(cwd, ".pi", "settings.json");
		await fs.mkdir(path.dirname(projectFile), { recursive: true });
		await fs.writeFile(file, JSON.stringify({ packages: ["example-package"], extensions: ["existing.ts"], theme: "dark" }));
		await fs.writeFile(projectFile, "{}");
		await fs.mkdir(path.join(agentDir, "extensions"), { recursive: true });
		await fs.mkdir(path.join(cwd, ".pi", "extensions"), { recursive: true });
		await fs.writeFile(path.join(agentDir, "extensions", "sample.ts"), "export default () => {};");
		await fs.writeFile(path.join(cwd, ".pi", "extensions", "sample.ts"), "export default () => {};");
		await fs.writeFile(path.join(cwd, ".pi", "extensions", "x.ts"), "export default () => {};");
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		mode = "ok";
		manager = SettingsManager.fromStorage({
			withLock(scope, update) {
				const target = scope === "global" ? file : projectFile;
				const next = update(readFileSync(target, "utf8"));
				if (next === undefined) return;
				if (mode === "deny") throw Object.assign(new Error("EACCES: settings write denied"), { code: "EACCES" });
				if (mode === "ok") writeFileSync(target, next, "utf8");
			},
		});
		manager.setProjectTrusted(true);
		mocks.getSettingsManager.mockReset().mockReturnValue(manager);
		// Package operations are mocked: no package download/install/uninstall ever occurs.
		mocks.installAndPersist.mockReset().mockImplementation(async (source: string, { local }: { local: boolean }) => {
			const settings = local ? manager.getProjectSettings() : manager.getGlobalSettings();
			const packages = [...settings.packages ?? [], source];
			if (local) manager.setProjectPackages(packages);
			else manager.setPackages(packages);
		});
		mocks.removeAndPersist.mockReset().mockImplementation(async (source: string, { local }: { local: boolean }) => {
			const settings = local ? manager.getProjectSettings() : manager.getGlobalSettings();
			const old = settings.packages ?? [];
			const packages = old.filter((item) => (typeof item === "string" ? item : item.source) !== source);
			if (packages.length === old.length) return false;
			if (local) manager.setProjectPackages(packages);
			else manager.setPackages(packages);
			return true;
		});
		const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager: manager });
		mocks.getPackageManager.mockReset().mockReturnValue({
			installAndPersist: mocks.installAndPersist, removeAndPersist: mocks.removeAndPersist,
			resolve: packageManager.resolve.bind(packageManager),
			// These mocked package operations use synthetic sources verbatim rather than resolving local paths.
			parseSource: () => ({ type: "synthetic" }),
			packageSourcesMatch: (entry: unknown, source: string) => (typeof entry === "string" ? entry : (entry as { source?: unknown } | null)?.source) === source,
		});
		mocks.reloadAllLoaders.mockClear();
		mocks.reloadSessionsForCwd.mockClear();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		await recycleGeneratedFixture(agentDir);
	});

	function expectNoResourceReload() {
		expect(mocks.reloadAllLoaders).not.toHaveBeenCalled();
		expect(mocks.reloadSessionsForCwd).not.toHaveBeenCalled();
	}

	function useNativeLocalPackageManager() {
		// Native local removal only updates its declaration; it cannot install or delete source files.
		const native = new DefaultPackageManager({ cwd, agentDir, settingsManager: manager });
		mocks.getPackageManager.mockReturnValue(native);
		return native;
	}

	it.each([false, true])("removes a settings-relative local package in its own scope without touching either source tree, project=%s", async (local) => {
		const source = "./configured-package";
		await fs.writeFile(file, JSON.stringify({ packages: [source], theme: "dark" }));
		await fs.writeFile(projectFile, JSON.stringify({ packages: [{ source, extensions: ["keep.ts"] }], theme: "project-theme" }));
		const roots = [path.join(agentDir, "configured-package"), path.join(cwd, ".pi", "configured-package")];
		for (const root of roots) {
			await fs.mkdir(root);
			await fs.writeFile(path.join(root, "keep.ts"), "keep original local code");
		}
		const target = local ? projectFile : file, other = local ? file : projectFile;
		const otherBytes = await fs.readFile(other);
		const native = useNativeLocalPackageManager();
		const remove = vi.spyOn(native, "removeAndPersist");
		await expect(removePackage(source, local, cwd)).resolves.toBe(true);
		expect(remove).toHaveBeenCalledWith(path.resolve(path.dirname(target), source), { local });
		expect(JSON.parse(await fs.readFile(target, "utf8")).packages).toEqual([]);
		expect(await fs.readFile(other)).toEqual(otherBytes);
		for (const root of roots) expect(await fs.readFile(path.join(root, "keep.ts"), "utf8")).toBe("keep original local code");
	});

	it.each([
		{ local: false, disabledOnly: false }, { local: true, disabledOnly: false },
		{ local: false, disabledOnly: true }, { local: true, disabledOnly: true },
	])("removes a missing settings-relative local declaration, project=$local disabled=$disabledOnly", async ({ local, disabledOnly }) => {
		const source = "./missing-package", record = { source, extensions: ["kept.ts"] };
		const target = local ? projectFile : file, other = local ? file : projectFile;
		await fs.writeFile(target, JSON.stringify({ theme: "keep", packages: disabledOnly ? ["./untouched-package"] : [record], disabledPackages: disabledOnly ? [record] : [] }));
		await fs.writeFile(other, JSON.stringify({ packages: [source], disabledPackages: [record], unknown: { keep: true } }));
		const otherBytes = await fs.readFile(other);
		const native = useNativeLocalPackageManager();
		expect(native.getInstalledPath(source, local ? "project" : "user")).toBeUndefined();
		await expect(removePackage(source, local, cwd)).resolves.toBe(true);
		expect(JSON.parse(await fs.readFile(target, "utf8"))).toEqual({ theme: "keep", packages: disabledOnly ? ["./untouched-package"] : [], disabledPackages: [] });
		expect(await fs.readFile(other)).toEqual(otherBytes);
	});

	it("keeps normal cwd-relative SDK inputs when they are not an exact configured source", async () => {
		const configured = "../configured-package", input = "./configured-package";
		await fs.writeFile(projectFile, JSON.stringify({ packages: [configured], theme: "keep" }));
		const native = useNativeLocalPackageManager();
		const remove = vi.spyOn(native, "removeAndPersist");
		await expect(removePackage(input, true, cwd)).resolves.toBe(true);
		expect(remove).toHaveBeenCalledWith(input, { local: true });
		expect(JSON.parse(await fs.readFile(projectFile, "utf8"))).toEqual({ packages: [], theme: "keep" });
	});


	it("lets a pending SettingsManager write land before moving a package, so it cannot resurrect the old list", async () => {
		// SDK 的写入是排队异步落盘的：直接改文件前不 flush，排在后面的旧 packages 会把停用的包写回去
		manager.setPackages(["example-package", "other-package"]);
		await togglePackage("example-package", true, "user", cwd);
		await manager.flush();
		const saved = JSON.parse(await fs.readFile(file, "utf8"));
		expect(saved.packages).toEqual(["other-package"]);
		expect(saved.disabledPackages).toEqual(["example-package"]);
	});

	it("treats project extension paths case-sensitively except on Windows", async () => {
		const upper = path.join(path.dirname(cwd), path.basename(cwd).toUpperCase(), ".pi", "extensions", "x.ts");
		if (process.platform !== "win32") {
			await expect(toggleExtension(upper, true, cwd)).rejects.toThrow("no longer configured");
			expectNoResourceReload();
			return;
		}
		await toggleExtension(upper, true, cwd);
		const projectPatterns = JSON.parse(await fs.readFile(projectFile, "utf8")).extensions ?? [];
		expect(projectPatterns.some((p: string) => p.startsWith("-"))).toBe(true);
	});

	it("refreshes stale global arrays before updating and flushes the extension exclusion", async () => {
		await fs.writeFile(file, JSON.stringify({ extensions: ["external.ts"], theme: "light", unknown: { retained: true } }));
		await toggleExtension(path.join(agentDir, "extensions", "sample.ts"), true, cwd);
		expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({
			extensions: ["external.ts", "-extensions/sample.ts"], theme: "light", unknown: { retained: true },
		});
		expect(mocks.reloadAllLoaders).toHaveBeenCalledOnce();
	});

	it("disables and re-enables a built-in extension with -builtin:<name> in the global settings", async () => {
		await toggleExtension("builtin:mcp", true, cwd);
		expect(JSON.parse(await fs.readFile(file, "utf8")).extensions).toEqual(["existing.ts", "-builtin:mcp"]);
		expect(JSON.parse(await fs.readFile(projectFile, "utf8")).extensions).toBeUndefined();
		await toggleExtension("builtin:mcp", false, cwd);
		expect(JSON.parse(await fs.readFile(file, "utf8")).extensions).toEqual(["existing.ts"]);
		expect(mocks.reloadSessionsForCwd).toHaveBeenLastCalledWith(undefined);
	});

	it("rewrites the project override of a built-in extension, which wins over the global setting", async () => {
		await fs.writeFile(file, JSON.stringify({ extensions: ["-builtin:mcp"] }));
		await fs.writeFile(projectFile, JSON.stringify({ extensions: ["local.ts", "-builtin:mcp"] }));
		await manager.reload();
		await toggleExtension("builtin:mcp", false, cwd);
		// 只删掉项目里的 `-` 会让全局的 `-builtin:mcp` 重新生效，所以写成显式的 `+`
		expect(JSON.parse(await fs.readFile(projectFile, "utf8")).extensions).toEqual(["local.ts", "+builtin:mcp"]);
		expect(JSON.parse(await fs.readFile(file, "utf8")).extensions).toEqual(["-builtin:mcp"]);
		expect(mocks.reloadSessionsForCwd).toHaveBeenLastCalledWith(cwd);
	});

	it.each([false, true])("surfaces swallowed extension SDK errors for project=%s", async (project) => {
		mode = "deny";
		const target = project ? path.join(cwd, ".pi", "extensions", "sample.ts") : path.join(agentDir, "extensions", "sample.ts");
		await expect(toggleExtension(target, true, cwd)).rejects.toThrow("EACCES");
		expectNoResourceReload();
	});

	it("detects silent extension persistence failures", async () => {
		mode = "drop";
		await expect(toggleExtension(path.join(agentDir, "extensions", "sample.ts"), true, cwd)).rejects.toThrow("not persisted");
		expectNoResourceReload();
	});

	it.each(["install", "remove"] as const)("surfaces swallowed %s persistence failures without reloading", async (action) => {
		mode = "deny";
		const original = await fs.readFile(file, "utf8");
		const operation = action === "install" ? installPackage("new-package", false, cwd) : removePackage("example-package", false, cwd);
		await expect(operation).rejects.toThrow("EACCES");
		expect(await fs.readFile(file, "utf8")).toBe(original);
		expectNoResourceReload();
	});

	it("rejects broken files before attempting any package operation", async () => {
		await fs.writeFile(file, "{broken");
		await expect(installPackage("new-package", false, cwd)).rejects.toThrow();
		await expect(removePackage("example-package", false, cwd)).rejects.toThrow();
		expect(mocks.installAndPersist).not.toHaveBeenCalled();
		expect(mocks.removeAndPersist).not.toHaveBeenCalled();
		expect(await fs.readFile(file, "utf8")).toBe("{broken");
		expectNoResourceReload();
	});

	it("preserves disabled package records if SDK uninstall fails", async () => {
		await fs.writeFile(file, JSON.stringify({ packages: [], disabledPackages: ["example-package"] }));
		mocks.removeAndPersist.mockRejectedValueOnce(new Error("uninstall failed"));
		await expect(removePackage("example-package", false, cwd)).rejects.toThrow("uninstall failed");
		expect(JSON.parse(await fs.readFile(file, "utf8")).disabledPackages).toEqual(["example-package"]);
		expectNoResourceReload();
	});

	it("reports success when removing only the disabled package record", async () => {
		await fs.writeFile(file, JSON.stringify({ packages: [], disabledPackages: [{ source: "example-package", extensions: ["kept"] }], theme: "dark" }));
		await expect(removePackage("example-package", false, cwd)).resolves.toBe(true);
		expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({ packages: [], disabledPackages: [], theme: "dark" });
		expect(mocks.reloadAllLoaders).toHaveBeenCalledOnce();
	});

	it("returns API errors instead of success for SDK write failures", async () => {
		mode = "deny";
		const response = await POST(new Request("http://localhost/api/plugins", {
			method: "POST", headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ action: "toggle", kind: "extension", path: path.join(agentDir, "extensions", "sample.ts"), disabled: true, cwd }),
		}));
		expect(response.status).toBe(500);
		expect(await response.json()).toMatchObject({ success: false, errorCode: "EACCES", error: "没有权限访问请求的资源。" });
		expectNoResourceReload();
	});
});
