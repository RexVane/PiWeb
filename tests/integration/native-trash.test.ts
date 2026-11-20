import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { moveToTrash } from "@/lib/recycle-bin";
import { recycleGeneratedFixture } from "../fixtures/system-trash";

/** Opt-in: only our generated fixtures enter the real macOS Trash. */
describe.skipIf(process.platform !== "darwin" || process.env.PIWEB_NATIVE_TRASH_TESTS !== "1")("real macOS system Trash", () => {
	let directory: string, root: string, trash: string;
	beforeAll(async () => {
		directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "piweb-native-trash-fixtures-")));
		root = path.join(directory, "managed"); await fs.mkdir(root);
		// NSFileManager uses the logged-in system user's Trash, not an isolated
		// HOME override. Never enumerate it: access only our UUID-named entries.
		trash = path.join(os.userInfo().homedir, ".Trash");
	});
	afterAll(async () => { await recycleGeneratedFixture(directory); });
	it("puts a file into the real Trash without a backup or body changes", async () => {
		const name = `piweb-native-file-${randomUUID()}-'中文.md`, file = path.join(root, name);
		await fs.writeFile(file, "exact template body\n");
		await moveToTrash(file, { managedRoot: root, expectedLink: false, expectedCanonical: file, expectedKind: "file" });
		expect(await fs.readFile(path.join(trash, name), "utf8")).toBe("exact template body\n");
		await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
		await expect(fs.stat(path.join(directory, "backups"))).rejects.toMatchObject({ code: "ENOENT" });
	});
	it("puts only a file link in Trash and retains the external target", async () => {
		const name = `piweb-native-link-${randomUUID()}.md`, alias = path.join(root, name), target = path.join(directory, `${name}.target`);
		await fs.writeFile(target, "retain link target"); await fs.symlink(target, alias);
		await moveToTrash(alias, { managedRoot: root, expectedLink: true, expectedKind: "file" });
		expect((await fs.lstat(path.join(trash, name))).isSymbolicLink()).toBe(true);
		expect(await fs.readlink(path.join(trash, name))).toBe(target); expect(await fs.readFile(target, "utf8")).toBe("retain link target");
	});
	it("recycles a directory link itself rather than coercing it to its target", async () => {
		const name = `piweb-native-directory-link-${randomUUID()}`, alias = path.join(root, name), target = path.join(directory, `${name}-target`);
		await fs.mkdir(target); await fs.writeFile(path.join(target, "keep.txt"), "keep directory target"); await fs.symlink(target, alias, "dir");
		await moveToTrash(alias, { managedRoot: root, expectedLink: true, expectedKind: "directory" });
		expect((await fs.lstat(path.join(trash, name))).isSymbolicLink()).toBe(true);
		expect(await fs.readFile(path.join(target, "keep.txt"), "utf8")).toBe("keep directory target");
	});
	it("recycles a skill directory intact, including its link rather than the link target", async () => {
		const name = `piweb-native-skill-${randomUUID()}`, directory = path.join(root, name), target = path.join(root, `${name}-outside.txt`);
		await fs.mkdir(directory); await fs.writeFile(path.join(directory, "SKILL.md"), "skill body"); await fs.writeFile(target, "outside data");
		await fs.symlink(target, path.join(directory, "reference.txt"));
		await moveToTrash(directory, { managedRoot: root, expectedLink: false, expectedCanonical: directory, expectedKind: "directory" });
		expect(await fs.readFile(path.join(trash, name, "SKILL.md"), "utf8")).toBe("skill body");
		expect((await fs.lstat(path.join(trash, name, "reference.txt"))).isSymbolicLink()).toBe(true);
		expect(await fs.readFile(target, "utf8")).toBe("outside data");
	});
});
