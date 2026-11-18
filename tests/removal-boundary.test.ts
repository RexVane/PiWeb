import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { removalMounts, withProtectedRemovalSource } from "../src/lib/removal-boundary";
import { recoverableRemove } from "../src/lib/recoverable-remove";
import { recycleFixture } from "./fixtures/recycle";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await recycleFixture(root); });
async function fixture() {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "piweb-removal-boundary-"))); roots.push(root);
	const parent = path.join(root, "skills"), victim = path.join(root, "victim");
	await fs.mkdir(parent); await fs.mkdir(victim);
	await fs.writeFile(path.join(parent, "skill.md"), "original"); await fs.writeFile(path.join(victim, "skill.md"), "external");
	return { root, parent, victim, target: path.join(parent, "skill.md") };
}

it("recognizes same-device bind mounts and escaped mount paths without relying on st_dev", () => {
	const source = "41 25 8:1 /outside /workspace/skills/a rw - ext4 /dev/sda rw\n42 25 8:1 /second /workspace/skills/a/nested\\040mount rw - ext4 /dev/sda rw\n43 25 8:1 /other /workspace/skills/b rw - ext4 /dev/sda rw";
	expect(removalMounts(source, "/workspace/skills/a", "/workspace/skills")).toEqual(["/workspace/skills/a", "/workspace/skills/a/nested mount"]);
	expect(removalMounts(source, "/workspace/skills/a/child", "/workspace/skills")).toEqual(["/workspace/skills/a"]);
});

it("rejects an ancestor already replaced by a junction before removal", async () => {
	const { root, parent, victim, target } = await fixture();
	await fs.rename(parent, `${parent}.original`); await fs.symlink(victim, parent, process.platform === "win32" ? "junction" : "dir");
	await expect(recoverableRemove(target, { cwd: root, reason: "probe", expectedCanonical: target })).rejects.toThrow();
	expect(await fs.readFile(path.join(victim, "skill.md"), "utf8")).toBe("external");
	expect(await fs.readFile(path.join(`${parent}.original`, "skill.md"), "utf8")).toBe("original");
});

it("keeps operations on their original directory when a competing rename is attempted", async () => {
	const { parent, target } = await fixture();
	await withProtectedRemovalSource(target, async (source) => {
		const moved = await fs.rename(parent, `${parent}.moved`).then(() => true, () => false);
		if (process.platform === "win32") expect(moved).toBe(false);
		expect(await fs.readFile(source, "utf8")).toBe("original");
	});
});

it("rejects a final directory replaced by a link after planning", async () => {
	const { root, parent, victim } = await fixture();
	const target = path.join(parent, "bundle"); await fs.mkdir(target);
	await fs.rename(target, `${target}.original`); await fs.symlink(victim, target, process.platform === "win32" ? "junction" : "dir");
	await expect(recoverableRemove(target, { cwd: root, reason: "probe", expectedCanonical: target })).rejects.toThrow("changed");
	expect(await fs.readFile(path.join(victim, "skill.md"), "utf8")).toBe("external");
});
