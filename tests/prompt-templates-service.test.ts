import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DefaultPackageManager, DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { JsoncSettingsStorage, readJsoncSettingsObjectSync } from "@/lib/jsonc-settings-storage";

const state = vi.hoisted(() => ({
	agentDir: "", trusted: true,
	manager: undefined as unknown as SettingsManager,
	packages: undefined as unknown as DefaultPackageManager,
	reloadLoaders: vi.fn(async () => []), reloadSessions: vi.fn(async (_cwd?: string) => 0),
	remove: vi.fn(async (removed: string, _options: unknown) => ({ removed })),
}));
vi.mock("@/lib/pi", () => ({
	getAgentDir: () => state.agentDir,
	getSettingsManager: () => state.manager,
	getPackageManager: () => state.packages,
	resolveProjectTrust: () => ({ trusted: state.trusted }),
	reloadAllLoaders: state.reloadLoaders,
}));
vi.mock("@/lib/agent-manager", () => ({ reloadSessionsForCwd: state.reloadSessions }));
vi.mock("@/lib/recycle-bin", () => ({ moveToTrash: state.remove }));

import { deletePromptTemplate, listPromptTemplates, MAX_PROMPT_TEMPLATE_BYTES, previewDeletePromptTemplate, readPromptTemplate, setPromptTemplateDisabled } from "@/lib/prompt-templates-service";

let group: string;
let directory: string;
let cwd: string;
let settings: string;
let projectSettings: string;
let userTemplate: string;
let projectTemplate: string;
const markdown = "---\ndescription: Review code carefully\nargument-hint: '[focus]'\n---\nReview ${1:-correctness}.\n";

beforeAll(async () => {
	group = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "piweb-template-fixtures-")));
});
beforeEach(async () => {
	directory = await fs.mkdtemp(path.join(group, "case-"));
	cwd = path.join(directory, "project");
	state.agentDir = path.join(directory, "agent");
	settings = path.join(state.agentDir, "settings.json");
	projectSettings = path.join(cwd, ".pi", "settings.json");
	userTemplate = path.join(state.agentDir, "prompts", "review.md");
	projectTemplate = path.join(cwd, ".pi", "prompts", "deploy.md");
	await fs.mkdir(path.dirname(userTemplate), { recursive: true });
	await fs.mkdir(path.dirname(projectTemplate), { recursive: true });
	await fs.mkdir(path.join(directory, "home"));
	vi.stubEnv("HOME", path.join(directory, "home"));
	vi.stubEnv("USERPROFILE", path.join(directory, "home"));
	await fs.writeFile(settings, '{\n\t// keep this comment\n\t"theme": "dark",\n\t"retry": {"maxRetries": 3}\n}\n');
	await fs.writeFile(projectSettings, "{}\n");
	await fs.writeFile(userTemplate, markdown);
	await fs.writeFile(projectTemplate, "Deploy the project\n");
	state.trusted = true;
	state.manager = SettingsManager.fromStorage(new JsoncSettingsStorage(cwd, state.agentDir), { projectTrusted: true });
	state.packages = new DefaultPackageManager({ cwd, agentDir: state.agentDir, settingsManager: state.manager });
	state.reloadLoaders.mockReset().mockResolvedValue([]);
	state.reloadSessions.mockReset().mockResolvedValue(0);
	state.remove.mockReset().mockImplementation(async (removed) => ({ removed }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
afterAll(async () => {
	// Only our generated fixtures are recycled. Headless runners may retain their
	// temporary directory until the runner disposes of its sandbox.
	if (process.platform === "darwin") await promisify(execFile)("osascript", ["-e", "on run argv", "-e", 'tell application "Finder" to delete (POSIX file (item 1 of argv) as alias)', "-e", "end run", group]).catch(() => undefined);
});

async function localPackage(filters?: string[]) {
	const root = path.join(directory, "package");
	await fs.mkdir(path.join(root, "prompts"), { recursive: true });
	await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "test-templates", pi: { prompts: ["prompts/*.md"] } }));
	const first = path.join(root, "prompts", "one.md");
	const second = path.join(root, "prompts", "two.md");
	await fs.writeFile(first, "One template"); await fs.writeFile(second, "Two template");
	await fs.writeFile(settings, JSON.stringify({ theme: "dark", packages: [{ source: root, ...(filters ? { prompts: filters } : {}), extensions: [] }] }));
	return { root, first, second };
}

async function link(from: string, to: string, directory = false): Promise<boolean> {
	try { await fs.symlink(from, to, directory && process.platform === "win32" ? "junction" : directory ? "dir" : "file"); return true; }
	catch (error) { if (["EPERM", "EACCES", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code || "")) return false; throw error; }
}

describe("prompt template discovery and persistence", () => {
	it("lists SDK personal, project and disabled templates with command metadata", async () => {
		await fs.writeFile(settings, JSON.stringify({ prompts: ["-prompts/review.md"] }));
		const templates = await listPromptTemplates(cwd);
		expect(templates.find((template) => template.filePath === userTemplate)).toMatchObject({ name: "review", description: "Review code carefully", argumentHint: "[focus]", scope: "user", origin: "top-level", disabled: true, canToggle: true, canDelete: true });
		expect(templates.find((template) => template.filePath === projectTemplate)).toMatchObject({ name: "deploy", scope: "project", disabled: false });
	});

	it("does not load untrusted project templates or install missing packages while listing", async () => {
		state.trusted = false;
		await fs.writeFile(settings, JSON.stringify({ packages: ["npm:@piweb/nonexistent-template-fixture"] }));
		const install = vi.spyOn(state.packages, "install").mockRejectedValue(new Error("must not install"));
		expect((await listPromptTemplates(cwd)).every((template) => template.scope === "user")).toBe(true);
		expect(install).not.toHaveBeenCalled();
	});

	it("uses official +/- filters, keeps Markdown and unrelated JSONC unchanged, and can re-enable", async () => {
		await setPromptTemplateDisabled(userTemplate, true, cwd);
		expect(readJsoncSettingsObjectSync(settings)).toEqual({ theme: "dark", retry: { maxRetries: 3 }, prompts: ["-prompts/review.md"] });
		expect(await fs.readFile(settings, "utf8")).toContain("// keep this comment");
		expect(await fs.readFile(userTemplate, "utf8")).toBe(markdown);
		expect(state.reloadSessions).toHaveBeenLastCalledWith(undefined);
		await setPromptTemplateDisabled(userTemplate, false, cwd);
		expect(readJsoncSettingsObjectSync(settings).prompts).toEqual(["+prompts/review.md"]);
		expect((await listPromptTemplates(cwd)).find((template) => template.name === "review")?.disabled).toBe(false);
	});

	it("writes project toggles only to project settings and refreshes that workspace", async () => {
		const original = await fs.readFile(settings, "utf8");
		await setPromptTemplateDisabled(projectTemplate, true, cwd);
		expect(readJsoncSettingsObjectSync(projectSettings).prompts).toEqual(["-prompts/deploy.md"]);
		expect(await fs.readFile(settings, "utf8")).toBe(original);
		expect(state.reloadSessions).toHaveBeenLastCalledWith(cwd);
	});

	it("keeps glob exclusions and exact source declarations when enabling a template", async () => {
		await fs.writeFile(settings, JSON.stringify({ prompts: ["prompts", "!prompts/*.md", "-prompts/review.md"] }));
		await setPromptTemplateDisabled(userTemplate, false, cwd);
		expect(readJsoncSettingsObjectSync(settings).prompts).toEqual(["prompts", "!prompts/*.md", "+prompts/review.md"]);
	});

	it("merges concurrent toggles rather than losing another template's state", async () => {
		const second = path.join(path.dirname(userTemplate), "second.md");
		await fs.writeFile(second, "A second template");
		await Promise.all([setPromptTemplateDisabled(userTemplate, true, cwd), setPromptTemplateDisabled(second, true, cwd)]);
		expect(readJsoncSettingsObjectSync(settings).prompts).toEqual(expect.arrayContaining(["-prompts/review.md", "-prompts/second.md"]));
	});

	it("refuses malformed settings without rewriting them", async () => {
		await listPromptTemplates(cwd);
		await fs.writeFile(settings, "{broken settings");
		await expect(setPromptTemplateDisabled(userTemplate, true, cwd)).rejects.toThrow();
		expect(await fs.readFile(settings, "utf8")).toBe("{broken settings");
	});

	it("keeps a saved toggle when refresh fails, returns a warning, and still attempts session refresh", async () => {
		state.reloadLoaders.mockRejectedValueOnce(new Error("loader failed"));
		const result = await setPromptTemplateDisabled(userTemplate, true, cwd);
		expect(result).toMatchObject({ changed: true, warning: expect.any(String) });
		expect(readJsoncSettingsObjectSync(settings).prompts).toEqual(["-prompts/review.md"]);
		expect(state.reloadSessions).toHaveBeenCalled();
	});

	it("filters one package template without changing its siblings or other resource filters", async () => {
		const { root, first, second } = await localPackage();
		await setPromptTemplateDisabled(first, true, cwd);
		expect(readJsoncSettingsObjectSync(settings).packages).toEqual([{ source: root, extensions: [], prompts: ["-prompts/one.md"] }]);
		let templates = await listPromptTemplates(cwd);
		expect(templates.find((template) => template.filePath === first)).toMatchObject({ origin: "package", disabled: true, canDelete: false });
		expect(templates.find((template) => template.filePath === second)?.disabled).toBe(false);
		await setPromptTemplateDisabled(first, false, cwd);
		templates = await listPromptTemplates(cwd);
		expect(templates.find((template) => template.filePath === first)?.disabled).toBe(false);
	});

	it("enables only the selected package template when its prompts filter is empty", async () => {
		const { first, second } = await localPackage([]);
		await setPromptTemplateDisabled(first, false, cwd);
		const templates = await listPromptTemplates(cwd);
		expect(templates.find((template) => template.filePath === first)?.disabled).toBe(false);
		expect(templates.find((template) => template.filePath === second)?.disabled).toBe(true);
	});

	it("removes disabled commands from the official loader and restores them after enabling", async () => {
		const loader = new DefaultResourceLoader({ cwd, agentDir: state.agentDir, settingsManager: state.manager });
		try {
			await loader.reload();
			expect(loader.getPrompts().prompts.find((template) => template.name === "review")).toMatchObject({ content: "Review ${1:-correctness}.", argumentHint: "[focus]" });
			await setPromptTemplateDisabled(userTemplate, true, cwd);
			await loader.reload();
			expect(loader.getPrompts().prompts.some((template) => template.name === "review")).toBe(false);
			await setPromptTemplateDisabled(userTemplate, false, cwd);
			await loader.reload();
			expect(loader.getPrompts().prompts.some((template) => template.name === "review")).toBe(true);
		} finally { loader.getExtensions().runtime.invalidate(); }
	});

	it("toggles a relative package source without losing its declaration", async () => {
		const { root, first } = await localPackage();
		const source = path.relative(state.agentDir, root).replace(/\\/g, "/");
		await fs.writeFile(settings, JSON.stringify({ packages: [source] }));
		await setPromptTemplateDisabled(first, true, cwd);
		expect(readJsoncSettingsObjectSync(settings).packages).toEqual([{ source, prompts: ["-prompts/one.md"] }]);
	});

	it("keeps a package template's project override in project settings", async () => {
		const { root, first, second } = await localPackage();
		const original = await fs.readFile(settings, "utf8");
		await fs.writeFile(projectSettings, JSON.stringify({ packages: [{ source: root, autoload: false, prompts: ["-prompts/one.md"] }] }));
		await setPromptTemplateDisabled(first, false, cwd);
		expect(readJsoncSettingsObjectSync(projectSettings).packages).toEqual([{ source: root, autoload: false, prompts: ["+prompts/one.md"] }]);
		expect(await fs.readFile(settings, "utf8")).toBe(original);
		expect((await listPromptTemplates(cwd)).find((template) => template.filePath === second)?.disabled).toBe(false);
		expect(state.reloadSessions).toHaveBeenLastCalledWith(cwd);
	});

	it("writes an external top-level template toggle to its declaration's scope", async () => {
		const external = path.join(directory, "external.md");
		await fs.writeFile(external, "External template");
		await fs.writeFile(projectSettings, JSON.stringify({ prompts: [external] }));
		await setPromptTemplateDisabled(external, true, cwd);
		expect(readJsoncSettingsObjectSync(projectSettings).prompts).toEqual([external, `-${external.replace(/\\/g, "/")}`]);
		expect(readJsoncSettingsObjectSync(settings).prompts).toBeUndefined();
	});
});

describe("template reads and system Trash deletion", () => {
	it("reads disabled files but refuses paths outside the discovered catalog", async () => {
		await fs.writeFile(settings, JSON.stringify({ prompts: ["-prompts/review.md"] }));
		expect(await readPromptTemplate(userTemplate, cwd)).toBe(markdown);
		const outside = path.join(directory, "not-a-template.md");
		await fs.writeFile(outside, "private");
		await expect(readPromptTemplate(outside, cwd)).rejects.toThrow();
		await expect(readPromptTemplate("review.md", cwd)).rejects.toThrow("Invalid prompt");
	});

	it("marks an oversized template unreadable without hiding the rest of the catalog", async () => {
		await fs.writeFile(userTemplate, "x".repeat(MAX_PROMPT_TEMPLATE_BYTES + 1));
		expect((await listPromptTemplates(cwd)).find((template) => template.name === "review")?.readError).toBe(true);
		await expect(readPromptTemplate(userTemplate, cwd)).rejects.toThrow("size limit");
	});

	it("previews and recycles only the selected Markdown file, never its directory", async () => {
		const plan = await previewDeletePromptTemplate(userTemplate, cwd);
		expect(plan).toEqual({ removed: userTemplate, link: false });
		const result = await deletePromptTemplate(userTemplate, cwd, plan.removed);
		expect(result).toEqual({ removed: userTemplate });
		expect(state.remove).toHaveBeenCalledWith(userTemplate, expect.objectContaining({ expectedLink: false, expectedCanonical: userTemplate, managedRoot: path.dirname(userTemplate), expectedKind: "file" }));
		await expect(fs.stat(path.join(directory, "backups"))).rejects.toMatchObject({ code: "ENOENT" });
		await expect(deletePromptTemplate(userTemplate, cwd, directory)).rejects.toThrow("review it again");
	});

	it("retains the template and does not refresh resources when system Trash is unavailable", async () => {
		state.remove.mockRejectedValueOnce(Object.assign(new Error("Trash unavailable"), { code: "TRASH_UNAVAILABLE" }));
		await expect(deletePromptTemplate(userTemplate, cwd, userTemplate)).rejects.toMatchObject({ code: "TRASH_UNAVAILABLE" });
		expect(await fs.readFile(userTemplate, "utf8")).toBe(markdown);
		expect(state.reloadLoaders).not.toHaveBeenCalled();
		expect(state.reloadSessions).not.toHaveBeenCalled();
	});

	it("refuses deleting package and external source files", async () => {
		const { first } = await localPackage();
		await expect(previewDeletePromptTemplate(first, cwd)).rejects.toThrow("cannot be deleted");
		const external = path.join(directory, "outside.md");
		await fs.writeFile(external, "An external template");
		await fs.writeFile(settings, JSON.stringify({ prompts: [external] }));
		expect((await listPromptTemplates(cwd)).find((template) => template.filePath === external)?.canDelete).toBe(false);
		await expect(previewDeletePromptTemplate(external, cwd)).rejects.toThrow("original source");
		expect(state.remove).not.toHaveBeenCalled();
	});

	it("removes a file link without touching its external target", async () => {
		const external = path.join(directory, "external.md");
		const alias = path.join(path.dirname(userTemplate), "alias.md");
		await fs.writeFile(external, "external source");
		if (!await link(external, alias)) return;
		const plan = await previewDeletePromptTemplate(alias, cwd);
		expect(plan).toEqual({ removed: alias, link: true });
		await deletePromptTemplate(alias, cwd, alias);
		expect(state.remove).toHaveBeenCalledWith(alias, expect.objectContaining({ expectedLink: true }));
		expect(await fs.readFile(external, "utf8")).toBe("external source");
	});

	it("refuses a top-level alias into an installed package", async () => {
		const { first } = await localPackage();
		const managed = path.join(state.agentDir, "npm", "node_modules", "pkg", "prompts");
		await fs.mkdir(managed, { recursive: true });
		const target = path.join(managed, "managed.md");
		await fs.copyFile(first, target);
		const alias = path.join(path.dirname(userTemplate), "alias.md");
		if (!await link(target, alias)) return;
		await expect(previewDeletePromptTemplate(alias, cwd)).rejects.toThrow("Package-managed");
		expect(state.remove).not.toHaveBeenCalled();
	});

	it("refuses linked project settings without modifying their external target", async () => {
		const source = path.join(directory, "external-settings.json");
		await fs.rename(projectSettings, source);
		if (!await link(source, projectSettings)) { await fs.rename(source, projectSettings); return; }
		await expect(setPromptTemplateDisabled(projectTemplate, true, cwd)).rejects.toThrow();
		expect(await fs.readFile(source, "utf8")).toBe("{}\n");
	});

	it("refuses directory aliases rather than following them into original sources", async () => {
		const external = path.join(directory, "linked-prompts");
		await fs.mkdir(external);
		await fs.writeFile(path.join(external, "linked.md"), "A linked source");
		const alias = path.join(cwd, ".pi", "prompts-alias");
		if (!await link(external, alias, true)) return;
		const template = path.join(alias, "linked.md");
		await fs.writeFile(projectSettings, JSON.stringify({ prompts: ["prompts-alias"] }));
		await expect(previewDeletePromptTemplate(template, cwd)).rejects.toThrow();
		expect(state.remove).not.toHaveBeenCalled();
	});
});
