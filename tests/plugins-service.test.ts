import fs from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
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
}));
vi.mock("../src/lib/agent-manager", () => ({ reloadSessionsForCwd: mocks.reloadSessionsForCwd }));

import { installPackage, removePackage, toggleExtension, togglePackage } from "../src/lib/plugins-service";
import { POST } from "../src/app/api/plugins/route";

it("preserves unrelated settings and never overwrites a malformed file when toggling a package", async () => {
	const previous = process.env.PI_CODING_AGENT_DIR;
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-plugin-settings-"));
	const file = path.join(agentDir, "settings.json");
	try {
		process.env.PI_CODING_AGENT_DIR = agentDir;
		await fs.writeFile(file, JSON.stringify({ theme: "dark", packages: ["example-package"], retry: { maxRetries: 5 } }));
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
		await fs.rm(agentDir, { recursive: true, force: true });
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
		mocks.getPackageManager.mockReset().mockReturnValue({ installAndPersist: mocks.installAndPersist, removeAndPersist: mocks.removeAndPersist });
		mocks.reloadAllLoaders.mockClear();
		mocks.reloadSessionsForCwd.mockClear();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		await fs.rm(agentDir, { recursive: true, force: true });
	});

	function expectNoResourceReload() {
		expect(mocks.reloadAllLoaders).not.toHaveBeenCalled();
		expect(mocks.reloadSessionsForCwd).not.toHaveBeenCalled();
	}

	it("refreshes stale global arrays before updating and flushes the extension exclusion", async () => {
		await fs.writeFile(file, JSON.stringify({ extensions: ["external.ts"], theme: "light", unknown: { retained: true } }));
		await toggleExtension(path.join(agentDir, "extensions", "sample.ts"), true, cwd);
		expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({
			extensions: ["external.ts", "-extensions/sample.ts"], theme: "light", unknown: { retained: true },
		});
		expect(mocks.reloadAllLoaders).toHaveBeenCalledOnce();
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
		expect(await response.json()).toMatchObject({ success: false, error: expect.stringContaining("EACCES") });
		expectNoResourceReload();
	});
});
