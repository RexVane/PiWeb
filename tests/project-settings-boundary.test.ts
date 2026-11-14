import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { JsoncSettingsStorage } from "@/lib/jsonc-settings-storage";
import { getPiSettings, patchPiSettings } from "@/lib/pi-settings";
import { recycleFixture } from "./lib/sandbox/fixtures";

vi.mock("@/lib/pi", async (original) => ({
	...await original<typeof import("@/lib/pi")>(),
	reloadSettingsManagers: vi.fn(async () => {}),
	resolveProjectTrust: vi.fn(() => ({ trusted: true })),
}));

let base: string;
let project: string;
let agent: string;
let previous: string | undefined;
beforeEach(() => {
	base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "piweb-project-settings-")));
	project = path.join(base, "project");
	agent = path.join(base, "agent");
	fs.mkdirSync(project);
	fs.mkdirSync(agent);
	previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agent;
});
afterEach(async () => {
	vi.restoreAllMocks();
	if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
	await recycleFixture(base);
});

it("rejects project settings behind a linked .pi directory in both UI and SDK access", async () => {
	const outside = path.join(base, "outside");
	fs.mkdirSync(outside);
	const external = path.join(outside, "settings.json");
	const contents = '{"steeringMode":"one-at-a-time"}';
	fs.writeFileSync(external, contents);
	fs.symlinkSync(outside, path.join(project, ".pi"), process.platform === "win32" ? "junction" : "dir");
	await expect(getPiSettings(project)).rejects.toThrow(/must not be a link/);
	await expect(patchPiSettings({ steeringMode: "all" }, project)).rejects.toThrow(/must not be a link/);
	expect(() => new JsoncSettingsStorage(project, agent).withLock("project", () => '{"steeringMode":"all"}')).toThrow(/must not be a link/);
	expect(fs.readFileSync(external, "utf8")).toBe(contents);
	expect(fs.readdirSync(outside)).toEqual(["settings.json"]);
});

it("rejects a hard-linked project settings file without changing another alias", async () => {
	const external = path.join(base, "outside.json");
	fs.writeFileSync(external, "{}");
	fs.mkdirSync(path.join(project, ".pi"));
	fs.linkSync(external, path.join(project, ".pi", "settings.json"));
	await expect(getPiSettings(project)).rejects.toThrow(/must not be linked/);
	await expect(patchPiSettings({ steeringMode: "all" }, project)).rejects.toThrow(/must not be linked/);
	expect(fs.readFileSync(external, "utf8")).toBe("{}");
});

it("does not create project directories while reading and preserves JSONC during synchronous SDK writes", async () => {
	const storage = new JsoncSettingsStorage(project, agent);
	let current: string | undefined = "unread";
	storage.withLock("project", (text) => { current = text; return undefined; });
	expect(current).toBeUndefined();
	expect(fs.existsSync(path.join(project, ".pi"))).toBe(false);
	await patchPiSettings({ steeringMode: "all" }, project);
	const file = path.join(project, ".pi", "settings.json");
	expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ steeringMode: "all" });
	fs.writeFileSync(file, '\uFEFF{\n// keep this comment\n"steeringMode":"all",\n"custom":true\n}\n');
	storage.withLock("project", (text) => JSON.stringify({ ...JSON.parse(text!), followUpMode: "all" }));
	const updated = fs.readFileSync(file, "utf8");
	expect(updated.startsWith("\uFEFF")).toBe(true);
	expect(updated).toContain("// keep this comment");
	expect(updated).toMatch(/"custom":\s*true/);
	expect((await getPiSettings(project)).followUpMode).toBe("all");
});

it("keeps an explicitly configured global agent directory alias usable", async () => {
	const alias = path.join(base, "agent-alias");
	fs.symlinkSync(agent, alias, process.platform === "win32" ? "junction" : "dir");
	process.env.PI_CODING_AGENT_DIR = alias;
	await patchPiSettings({ steeringMode: "all" });
	expect((await getPiSettings()).steeringMode).toBe("all");
	new JsoncSettingsStorage(project, alias).withLock("global", (text) => JSON.stringify({ ...JSON.parse(text!), followUpMode: "all" }));
	expect(JSON.parse(fs.readFileSync(path.join(agent, "settings.json"), "utf8"))).toEqual({ steeringMode: "all", followUpMode: "all" });
});

it("reads absent settings from a removed project but refuses to recreate it on write", () => {
	const storage = new JsoncSettingsStorage(project, agent);
	fs.renameSync(project, path.join(base, "moved-project"));
	let current: string | undefined = "unread";
	expect(() => storage.withLock("project", (value) => { current = value; return undefined; })).not.toThrow();
	expect(current).toBeUndefined();
	expect(() => storage.withLock("project", () => '{"steeringMode":"all"}')).toThrow(/ENOENT/);
	expect(fs.existsSync(project)).toBe(false);
	expect(fs.readdirSync(path.join(base, "moved-project"))).toEqual([]);
});

it.skipIf(process.platform !== "win32")("pins Windows project settings ancestors through the synchronous commit", async () => {
	const directory = path.join(project, ".pi");
	fs.mkdirSync(directory);
	const write = fs.writeFileSync.bind(fs);
	let checked = false;
	const spy = vi.spyOn(fs, "writeFileSync").mockImplementation((...args) => {
		if (String(args[0]).endsWith(".tmp")) {
			checked = true;
			expect(() => fs.renameSync(directory, path.join(project, "moved"))).toThrow();
			expect(() => fs.renameSync(project, path.join(base, "moved-project"))).toThrow();
		}
		return write(...args);
	});
	try { await patchPiSettings({ steeringMode: "all" }, project); }
	finally { spy.mockRestore(); }
	expect(checked).toBe(true);
	expect(JSON.parse(fs.readFileSync(path.join(directory, "settings.json"), "utf8")).steeringMode).toBe("all");
	fs.renameSync(directory, path.join(project, "moved"));
});
