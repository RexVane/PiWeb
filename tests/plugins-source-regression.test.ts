import fs from "node:fs/promises";
import { recycleGeneratedFixture } from "./fixtures/system-trash";
import os from "node:os";
import path from "node:path";
import { DefaultPackageManager, DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
	getSettingsManager: vi.fn(), getPackageManager: vi.fn(), getResourceLoader: vi.fn(),
	resourceLoaderReady: vi.fn(async () => {}), reloadAllLoaders: vi.fn(), reloadSessionsForCwd: vi.fn(async () => 0),
}));
vi.mock("../src/lib/pi", () => ({ ...runtime, getAgentDir: () => process.env.PI_CODING_AGENT_DIR }));
vi.mock("../src/lib/agent-manager", () => ({ reloadSessionsForCwd: runtime.reloadSessionsForCwd }));

import { listLoadedExtensions, listPackages, toggleExtension, togglePackage } from "../src/lib/plugins-service";
import { POST } from "../src/app/api/plugins/route";

let root: string;
let cwd: string;
let agentDir: string;
let globalFile: string;
let projectFile: string;
let sm: SettingsManager;
let pm: DefaultPackageManager;
let loader: DefaultResourceLoader;

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-plugin-sources-"));
	agentDir = path.join(root, "agent");
	cwd = path.join(root, "workspace");
	globalFile = path.join(agentDir, "settings.json");
	projectFile = path.join(cwd, ".pi", "settings.json");
	await fs.mkdir(agentDir, { recursive: true });
	await fs.mkdir(path.dirname(projectFile), { recursive: true });
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
	vi.stubEnv("PI_OFFLINE", "1");
	vi.stubGlobal("fetch", vi.fn(() => { throw new Error("network forbidden in plugin regression"); }));
	runtime.reloadSessionsForCwd.mockClear();
});

afterEach(async () => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	await recycleGeneratedFixture(root);
});

async function initialize(globalSettings: Record<string, unknown>, projectSettings: Record<string, unknown> = {}) {
	await fs.writeFile(globalFile, JSON.stringify(globalSettings));
	await fs.writeFile(projectFile, JSON.stringify(projectSettings));
	sm = SettingsManager.create(cwd, agentDir);
	sm.setProjectTrusted(true);
	pm = new DefaultPackageManager({ cwd, agentDir, settingsManager: sm });
	loader = new DefaultResourceLoader({
		cwd, agentDir, settingsManager: sm, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: [{ name: "mcp", builtin: true, factory: () => {} }],
	});
	await loader.reload();
	runtime.getSettingsManager.mockReturnValue(sm);
	runtime.getPackageManager.mockReturnValue(pm);
	runtime.getResourceLoader.mockReturnValue(loader);
	runtime.reloadAllLoaders.mockReset().mockImplementation(async () => { await loader.reload(); return [cwd]; });
}

async function extension(file: string) {
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, "export default function () {}\n");
	return file;
}

const posix = (file: string) => file.replace(/\\/g, "/");
const readSettings = async (file: string) => JSON.parse(await fs.readFile(file, "utf8"));
const resolved = async (file: string) => (await pm.resolve(async () => "skip")).extensions.find((item) => item.path === file);

describe("SDK-backed plugin source and scope regressions", () => {
	it.each(["user", "project"] as const)("exposes local package metadata and rejects its extension toggle in %s scope", async (scope) => {
		const packageDir = path.join(cwd, "local-package");
		const file = await extension(path.join(packageDir, "extension.js"));
		await fs.writeFile(path.join(packageDir, "package.json"), JSON.stringify({ name: "local-probe", pi: { extensions: ["extension.js"] } }));
		await initialize(scope === "user" ? { packages: [packageDir] } : {}, scope === "project" ? { packages: [packageDir] } : {});
		const beforeGlobal = await readSettings(globalFile);
		const beforeProject = await readSettings(projectFile);
		const response = await POST(new Request("http://localhost/api/plugins", {
			method: "POST", headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ action: "toggle", kind: "extension", path: file, disabled: true, cwd }),
		}));
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ success: false, error: expect.stringContaining("whole-package") });
		expect(await readSettings(globalFile)).toEqual(beforeGlobal);
		expect(await readSettings(projectFile)).toEqual(beforeProject);
		expect(await resolved(file)).toMatchObject({ enabled: true });
		expect((await listLoadedExtensions(cwd)).find((item) => item.path === file)).toMatchObject({
			disabled: false, scope, origin: "package", sourceInfo: { source: packageDir, origin: "package", scope },
		});
		expect((await listPackages(cwd)).find((item) => item.source === packageDir)).toMatchObject({
			scope, disabled: false, types: ["extensions"], resources: { extensions: 1, skills: 0, prompts: 0, themes: 0 },
		});
		expect(runtime.reloadAllLoaders).not.toHaveBeenCalled();
		await togglePackage(packageDir, true, scope, cwd);
		expect(await resolved(file)).toBeUndefined();
		expect((await listPackages(cwd)).find((item) => item.source === packageDir)).toMatchObject({ scope, disabled: true, types: ["extensions"] });
		await togglePackage(packageDir, false, scope, cwd);
		expect(await resolved(file)).toMatchObject({ enabled: true, metadata: { origin: "package", scope } });
	});

	it("preserves disabled package-child metadata and rejects enabling it as a standalone extension", async () => {
		const packageDir = path.join(cwd, "filtered-package");
		const file = await extension(path.join(packageDir, "extension.js"));
		await fs.writeFile(path.join(packageDir, "package.json"), JSON.stringify({ name: "filtered-probe", pi: { extensions: ["extension.js"] } }));
		await initialize({ packages: [{ source: packageDir, extensions: [] }] });
		expect((await listLoadedExtensions(cwd)).find((item) => item.path === file)).toMatchObject({ disabled: true, sourceInfo: { origin: "package", scope: "user" } });
		await expect(toggleExtension(file, false, cwd)).rejects.toThrow("whole-package");
		expect(await resolved(file)).toMatchObject({ enabled: false });
	});

	it.each(["user", "project"] as const)("toggles cross-boundary %s configuration in its own settings, including disabled rediscovery", async (scope) => {
		const file = await extension(scope === "user" ? path.join(cwd, "global-configured.js") : path.join(root, "external", "project-configured.js"));
		const config = { extensions: [file], custom: { preserved: true } };
		await initialize(scope === "user" ? config : {}, scope === "project" ? config : {});
		expect((await listLoadedExtensions(cwd)).find((item) => item.path === file)).toMatchObject({
			disabled: false, scope, origin: "top-level", sourceInfo: { scope },
		});
		const target = scope === "user" ? globalFile : projectFile;
		const other = scope === "user" ? projectFile : globalFile;
		const otherBefore = await readSettings(other);
		await toggleExtension(file, true, cwd);
		expect(await resolved(file)).toMatchObject({ enabled: false, metadata: { scope } });
		expect(await readSettings(other)).toEqual(otherBefore);
		expect((await readSettings(target)).custom).toEqual({ preserved: true });
		expect((await listLoadedExtensions(cwd)).find((item) => item.path === file)).toMatchObject({ disabled: true, scope, origin: "top-level", sourceInfo: { scope } });
		await toggleExtension(file, false, cwd);
		expect(await resolved(file)).toMatchObject({ enabled: true, metadata: { scope } });
		expect(await readSettings(other)).toEqual(otherBefore);
		expect(runtime.reloadSessionsForCwd).toHaveBeenLastCalledWith(scope === "user" ? undefined : cwd);
	});

	it("lists wildcard-disabled standalone resources and enables one without changing the rest", async () => {
		const file = await extension(path.join(root, "external", "chosen.js"));
		const other = await extension(path.join(root, "external", "other.js"));
		await initialize({}, { extensions: [path.dirname(file), `!${posix(path.dirname(file))}/*.js`] });
		expect((await listLoadedExtensions(cwd)).find((item) => item.path === file)).toMatchObject({ disabled: true, sourceInfo: { scope: "project" } });
		await toggleExtension(file, false, cwd);
		expect(await resolved(file)).toMatchObject({ enabled: true });
		expect(await resolved(other)).toMatchObject({ enabled: false });
	});

	it("keeps global and project builtin overrides working through actual loader reloads", async () => {
		await initialize({ extensions: ["-builtin:mcp"] }, { extensions: ["-builtin:mcp"] });
		expect((await listLoadedExtensions(cwd)).find((item) => item.path === "builtin:mcp")).toMatchObject({ disabled: true });
		await toggleExtension("builtin:mcp", false, cwd);
		expect(loader.getExtensions().extensions.some((item) => item.path === "builtin:mcp")).toBe(true);
		expect((await readSettings(projectFile)).extensions).toEqual(["+builtin:mcp"]);
		expect((await readSettings(globalFile)).extensions).toEqual(["-builtin:mcp"]);
	});
});
