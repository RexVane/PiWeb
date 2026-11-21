import fs from "node:fs/promises";
import { recycleGeneratedFixture } from "./fixtures/system-trash";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { resourceFingerprint } from "../src/lib/resource-fingerprint";

vi.mock("../src/lib/growth-tracker", () => ({
	GROWTH_TRACKER_VERSION: 1,
	createGrowthTracker: () => ({ version: 1, prepare: async () => {}, onEvent: () => {}, getError: () => null, dispose: () => {} }),
}));

let root: string;
let agentDir: string;
let workspace: string;
let pi: typeof import("../src/lib/pi");
let manager: typeof import("../src/lib/agent-manager");
const managed: ReturnType<typeof import("../src/lib/agent-manager")["getManaged"]>[] = [];
const skill = (name: string, description = "Initial skill") => `---\nname: ${name}\ndescription: ${description}\n---\nUse this skill.\n`;
async function write(file: string, content: string) {
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, content);
}

beforeAll(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-resource-refresh-"));
	agentDir = path.join(root, "agent");
	workspace = path.join(root, "repo", "workspace");
	await fs.mkdir(workspace, { recursive: true });
	await write(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "always", compaction: { enabled: false } }));
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
	vi.stubEnv("HOME", path.join(root, "home"));
	vi.stubEnv("PI_OFFLINE", "1");
	vi.stubGlobal("fetch", vi.fn(() => { throw new Error("network forbidden in resource regression"); }));
	vi.resetModules();
	pi = await import("../src/lib/pi");
	manager = await import("../src/lib/agent-manager");
}, 90_000);

afterAll(async () => {
	for (const session of managed) manager.disposeSession(session);
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	await recycleGeneratedFixture(root);
});

describe("SDK resource refresh", () => {
	it("refreshes instruction edits and newly added ancestor overrides in live sessions", async () => {
		const cwd = path.join(workspace, "instructions");
		await write(path.join(cwd, "AGENTS.md"), "Old project rule");
		await write(path.join(cwd, ".pi", "SYSTEM.md"), "Old system rule");
		await write(path.join(cwd, ".pi", "APPEND_SYSTEM.md"), "Old append rule");
		const { sessionPath } = await manager.createNewSession(cwd);
		const session = manager.getManaged(sessionPath);
		managed.push(session);
		await manager.ensureSession(session);
		expect(session.session!.systemPrompt).toContain("Old project rule");
		await write(path.join(cwd, "AGENTS.md"), "New project rule with changed length");
		await write(path.join(cwd, ".pi", "SYSTEM.md"), "New system rule with changed length");
		await write(path.join(cwd, ".pi", "APPEND_SYSTEM.md"), "New append rule with changed length");
		await write(path.join(workspace, "AGENTS.override.md"), "New ancestor override");
		await manager.buildSnapshot(session);
		expect(session.session!.systemPrompt).toContain("New project rule with changed length");
		expect(session.session!.systemPrompt).toContain("New system rule with changed length");
		expect(session.session!.systemPrompt).toContain("New append rule with changed length");
		expect(session.session!.systemPrompt).toContain("New ancestor override");
		expect(pi.resourceLoaderIsStale(cwd)).toBe(false);
	});

	it("discovers deeply nested .agents skills and changes to configured extra sources", async () => {
		const cwd = path.join(workspace, "skills");
		const extras = path.join(root, "extra-resources");
		await write(path.join(cwd, ".pi", "settings.json"), JSON.stringify({ skills: [path.join(extras, "skills")], prompts: [path.join(extras, "prompts")], extensions: [path.join(extras, "extensions")] }));
		await write(path.join(extras, "skills", "one", "SKILL.md"), skill("extra-one"));
		await write(path.join(extras, "prompts", "deep", "nested", "initial.md"), "Initial template");
		await write(path.join(extras, "extensions", "deep", "package.json"), JSON.stringify({ pi: { extensions: ["nested/entry.js"] } }));
		await write(path.join(extras, "extensions", "deep", "nested", "entry.js"), "export default function(pi) { pi.registerCommand('initial_command', { handler: async () => {} }); }");
		await pi.resourceLoaderReady(cwd);
		expect(pi.getResourceLoader(cwd).getPrompts().prompts.some((p) => p.name === "initial")).toBe(true);
		await write(path.join(workspace, ".agents", "skills", "a", "b", "c", "d", "SKILL.md"), skill("ancestor-deep"));
		await write(path.join(process.env.HOME!, ".agents", "skills", "a", "b", "c", "d", "SKILL.md"), skill("home-deep"));
		await write(path.join(extras, "skills", "one", "SKILL.md"), skill("extra-one", "Edited description"));
		await write(path.join(extras, "skills", "two", "a", "b", "c", "SKILL.md"), skill("extra-new"));
		await write(path.join(extras, "prompts", "deep", "nested", "new.md"), "New template");
		await write(path.join(extras, "extensions", "deep", "nested", "entry.js"), "export default function(pi) { pi.registerCommand('new_command', { handler: async () => {} }); }");
		expect(await pi.refreshResourceLoaderIfStale(cwd)).toBe(true);
		const loader = pi.getResourceLoader(cwd);
		expect(loader.getSkills().skills.map((s) => s.name)).toEqual(expect.arrayContaining(["ancestor-deep", "home-deep", "extra-one", "extra-new"]));
		expect(loader.getSkills().skills.find((s) => s.name === "extra-one")?.description).toBe("Edited description");
		expect(loader.getPrompts().prompts.some((p) => p.name === "new")).toBe(true);
		expect(loader.getExtensions().extensions.some((e) => e.commands.has("new_command"))).toBe(true);
		expect(pi.resourceLoaderIsStale(cwd)).toBe(false);
	});

	it("refreshes package manifest resources beyond the old depth limit", async () => {
		const cwd = path.join(workspace, "package");
		const packageRoot = path.join(root, "local-package");
		await write(path.join(cwd, ".pi", "settings.json"), JSON.stringify({ packages: [packageRoot] }));
		await write(path.join(packageRoot, "package.json"), JSON.stringify({ name: "refresh-fixture", pi: { skills: ["resources/skills"], prompts: ["resources/prompts/**/*.md"] } }));
		await write(path.join(packageRoot, "resources", "skills", "one", "SKILL.md"), skill("package-one"));
		await write(path.join(packageRoot, "resources", "prompts", "deep", "initial.md"), "Initial package template");
		await pi.resourceLoaderReady(cwd);
		await write(path.join(packageRoot, "resources", "skills", "new", "a", "b", "c", "d", "SKILL.md"), skill("package-deep"));
		await write(path.join(packageRoot, "resources", "prompts", "deep", "a", "b", "new-package.md"), "New package template");
		expect(await pi.refreshResourceLoaderIfStale(cwd)).toBe(true);
		expect(pi.getResourceLoader(cwd).getSkills().skills.some((s) => s.name === "package-deep")).toBe(true);
		expect(pi.getResourceLoader(cwd).getPrompts().prompts.some((p) => p.name === "new-package")).toBe(true);
	});

	it("does not swallow a write that happens after the loader reads a source", async () => {
		const cwd = path.join(workspace, "concurrent");
		const file = path.join(cwd, "AGENTS.md");
		await write(file, "Initial rule");
		await pi.resourceLoaderReady(cwd);
		const loader = pi.getResourceLoader(cwd);
		const reload = loader.reload.bind(loader);
		let changed = false;
		const wrapped = vi.spyOn(loader, "reload").mockImplementation(async (options) => {
			await reload(options);
			if (!changed) { changed = true; await write(file, "Edited during reload after the source was read"); }
		});
		await pi.reloadLoader(cwd);
		if (pi.resourceLoaderIsStale(cwd)) await pi.refreshResourceLoaderIfStale(cwd);
		expect(loader.getAgentsFiles().agentsFiles.find((source) => source.path === file)?.content).toBe("Edited during reload after the source was read");
		expect(pi.resourceLoaderIsStale(cwd)).toBe(false);
		wrapped.mockRestore();
	});

	it("limits discovery to resources, stops at skill roots, respects ignores and breaks symlink cycles", async () => {
		const cwd = path.join(workspace, "bounded");
		const skills = path.join(cwd, ".agents", "skills");
		const unrelated = path.join(cwd, "ordinary", "deep");
		await write(path.join(skills, ".gitignore"), "ignored/\n");
		await write(path.join(skills, "ignored", "SKILL.md"), skill("ignored"));
		await write(path.join(skills, "one", "SKILL.md"), skill("bounded"));
		await write(path.join(skills, "one", "references", "notes.md"), "Skill attachment");
		await write(path.join(unrelated, "secret.md"), "Not a resource");
		await write(path.join(cwd, ".pi", "settings.json"), JSON.stringify({ skills: [cwd], prompts: [process.env.HOME] }));
		let linked = false;
		try { await fs.symlink(skills, path.join(skills, "loop"), process.platform === "win32" ? "junction" : "dir"); linked = true; }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error; }
		const reads = vi.spyOn(fsSync, "readdirSync");
		const fingerprint = () => resourceFingerprint({ cwd, agentDir, trusted: true });
		const before = fingerprint();
		await write(path.join(skills, "ignored", "SKILL.md"), skill("ignored", "changed ignored content"));
		await write(path.join(skills, "one", "references", "notes.md"), "Changed attachment content");
		await write(path.join(unrelated, "secret.md"), "Changed ordinary content");
		expect(fingerprint()).toBe(before);
		expect(reads.mock.calls.some(([dir]) => String(dir).startsWith(unrelated))).toBe(false);
		expect(reads.mock.calls.some(([dir]) => String(dir).includes(`${path.sep}ignored`))).toBe(false);
		if (linked) expect(reads.mock.calls.filter(([dir]) => String(dir).endsWith(`${path.sep}loop`))).toHaveLength(0);
		reads.mockRestore();
	});
});
