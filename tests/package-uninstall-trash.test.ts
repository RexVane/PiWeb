import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { JsoncSettingsStorage } from "@/lib/jsonc-settings-storage";
import { securePackageManager } from "@/lib/package-manager-safe";
import { flushSettingsOrThrow } from "@/lib/settings-write-lock";
import { recycleGeneratedFixture } from "./fixtures/system-trash";

const native = vi.hoisted(() => ({ move: vi.fn(async (_target: string, _options: unknown) => ({ removed: _target })), destinations: [] as string[] }));
vi.mock("@/lib/recycle-bin", () => ({ moveToTrash: native.move }));
const source = "git:github.com/example/piweb-trash-fixture";
type Internals = { parseSource(source: string): unknown; getGitInstallPath(source: unknown, scope: string): string; getGitInstallRoot(scope: string): string };
let group: string, directory: string, cwd: string, agentDir: string, trash: string, manager: DefaultPackageManager, settings: SettingsManager;
beforeAll(async () => { group = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "piweb-git-trash-tests-"))); });
afterAll(async () => { await recycleGeneratedFixture(group); });
beforeEach(async () => {
	directory = await fs.mkdtemp(path.join(group, "case-")); cwd = path.join(directory, "project"); agentDir = path.join(directory, "agent"); trash = path.join(directory, "test-system-trash");
	for (const root of [cwd, agentDir, trash]) await fs.mkdir(root);
	await fs.writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ packages: [source], theme: "keep" }));
	settings = SettingsManager.fromStorage(new JsoncSettingsStorage(cwd, agentDir), { projectTrusted: true });
	manager = securePackageManager(new DefaultPackageManager({ cwd, agentDir, settingsManager: settings }));
	native.destinations = []; native.move.mockReset().mockImplementation(async (target) => {
		const destination = path.join(trash, `${randomUUID()}-${path.basename(target)}`);
		await fs.rename(target, destination); native.destinations.push(destination); return { removed: target };
	});
});
function location(scope = "user"): { root: string; target: string } {
	const sdk = manager as unknown as Internals;
	return { root: sdk.getGitInstallRoot(scope), target: sdk.getGitInstallPath(sdk.parseSource(source), scope) };
}
async function checkout(scope = "user"): Promise<string> {
	const { target } = location(scope); await fs.mkdir(target, { recursive: true }); await fs.writeFile(path.join(target, "user-edits.txt"), "preserve checkout edits"); return target;
}
async function link(target: string, alias: string): Promise<boolean> {
	try { await fs.symlink(target, alias, process.platform === "win32" ? "junction" : "dir"); return true; }
	catch (error) { if (["EPERM", "EACCES", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code || "")) return false; throw error; }
}

describe("official package removal uses system Trash for managed git checkouts", () => {
	it("recycles a git checkout including local edits instead of calling SDK recursive rm", async () => {
		const target = await checkout();
		expect(await manager.removeAndPersist(source)).toBe(true); await flushSettingsOrThrow(settings);
		expect(native.move).toHaveBeenCalledWith(target, expect.objectContaining({ managedRoot: location().root, expectedCanonical: target, expectedLink: false }));
		expect(await fs.readFile(path.join(native.destinations[0], "user-edits.txt"), "utf8")).toBe("preserve checkout edits");
		await expect(fs.stat(target)).rejects.toMatchObject({ code: "ENOENT" });
		expect(settings.getGlobalSettings().packages).toEqual([]); expect(settings.getGlobalSettings().theme).toBe("keep");
	});

	it("removes only the project checkout and leaves the user's copy configured and intact", async () => {
		const personal = await checkout(); const project = await checkout("project");
		settings.setProjectPackages([source]); await flushSettingsOrThrow(settings);
		await manager.removeAndPersist(source, { local: true }); await flushSettingsOrThrow(settings);
		expect(native.move).toHaveBeenCalledWith(project, expect.any(Object)); expect(await fs.readFile(path.join(personal, "user-edits.txt"), "utf8")).toBe("preserve checkout edits");
		expect(settings.getProjectSettings().packages).toEqual([]); expect(settings.getGlobalSettings().packages).toEqual([source]);
	});

	it("only removes a local package's declaration and never recycles the original source", async () => {
		const local = path.join(directory, "local-source"); await fs.mkdir(local); await fs.writeFile(path.join(local, "user-code.ts"), "keep local source");
		settings.setPackages([local]); await flushSettingsOrThrow(settings);
		expect(await manager.removeAndPersist(local)).toBe(true); await flushSettingsOrThrow(settings);
		expect(native.move).not.toHaveBeenCalled(); expect(await fs.readFile(path.join(local, "user-code.ts"), "utf8")).toBe("keep local source");
	});

	it("does not call the recycler for a package that has no installed files", async () => {
		expect(await manager.removeAndPersist(source)).toBe(true); await flushSettingsOrThrow(settings);
		expect(native.move).not.toHaveBeenCalled(); expect(settings.getGlobalSettings().packages).toEqual([]);
	});

	it("retains a checkout and its configuration if the system Trash is unavailable", async () => {
		const target = await checkout(); native.move.mockRejectedValueOnce(Object.assign(new Error("Trash unavailable"), { code: "TRASH_UNAVAILABLE" }));
		await expect(manager.removeAndPersist(source)).rejects.toMatchObject({ code: "TRASH_UNAVAILABLE" });
		expect(await fs.readFile(path.join(target, "user-edits.txt"), "utf8")).toBe("preserve checkout edits"); expect(settings.getGlobalSettings().packages).toEqual([source]);
	});

	it("rejects a cache-root alias into another source tree", async () => {
		const { root, target } = location(), external = path.join(directory, "external");
		const outside = path.join(external, path.relative(root, target)); await fs.mkdir(outside, { recursive: true }); await fs.writeFile(path.join(outside, "private.txt"), "external tree");
		if (!await link(external, root)) return;
		await expect(manager.removeAndPersist(source)).rejects.toThrow("must not be a link");
		expect(native.move).not.toHaveBeenCalled(); expect(await fs.readFile(path.join(outside, "private.txt"), "utf8")).toBe("external tree");
	});

	it("rejects a nested directory alias even when it targets another place inside the cache", async () => {
		const target = await checkout(), parent = path.dirname(target), { root } = location();
		const replacement = path.join(root, "other-parent"), outside = path.join(replacement, path.basename(target));
		await fs.mkdir(outside, { recursive: true }); await fs.writeFile(path.join(outside, "private.txt"), "other source"); await fs.rename(parent, `${parent}.saved`);
		if (!await link(replacement, parent)) return;
		await expect(manager.removeAndPersist(source)).rejects.toThrow("path changed");
		expect(native.move).not.toHaveBeenCalled(); expect(await fs.readFile(path.join(outside, "private.txt"), "utf8")).toBe("other source");
	});

	it("recycles only a checkout link without removing its actual target", async () => {
		const { target } = location(), outside = path.join(directory, "local-checkout");
		await fs.mkdir(outside); await fs.writeFile(path.join(outside, "private.txt"), "keep link target"); await fs.mkdir(path.dirname(target), { recursive: true });
		if (!await link(outside, target)) return;
		await manager.removeAndPersist(source); await flushSettingsOrThrow(settings);
		expect((await fs.lstat(native.destinations[0])).isSymbolicLink()).toBe(true);
		expect(await fs.readFile(path.join(outside, "private.txt"), "utf8")).toBe("keep link target");
	});
});
