import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRecoverableCopy, recoverableRemove } from "@/lib/recoverable-remove";
import { withSettingsWriteLock } from "@/lib/settings-write-lock";
import { recycleFixture } from "./fixtures/recycle";

const temporary: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(temporary.splice(0).map(recycleFixture)); });
async function setup() {
	const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "piweb-recoverable-")));
	temporary.push(dir); return dir;
}
describe("recoverable removal", () => {
	it("recycles a plain file with a quoted name after verifying and indexing its backup", async () => {
		const cwd = await setup(); const target = path.join(cwd, "O'Brien notes.txt");
		const content = "Quoted path and unicode 回收内容\n";
		await fs.writeFile(target, content);
		const result = await recoverableRemove(target, { cwd, reason: "plain file recycle fixture" });
		await expect(fs.stat(target)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await fs.readFile(result.backup, "utf8")).toBe(content);
		const index = await fs.readFile(result.index, "utf8");
		expect(index).toContain(target); expect(index).toContain(result.backup); expect(index).toContain("plain file recycle fixture");
		expect(index).not.toContain("未移除");
		if (process.platform === "win32") await expect(fs.stat(`${result.backup}.original`)).rejects.toMatchObject({ code: "ENOENT" });
		else expect(await fs.readFile(`${result.backup}.original`, "utf8")).toBe(content);
	});

	it("rechecks the source identity after acquiring the recovery index lock", async () => {
		const cwd = await setup(); const target = path.join(cwd, "selected.txt");
		await fs.writeFile(target, "original selected contents");
		const index = path.join(cwd, "backups", "INDEX.md");
		let unlock!: () => void, entered!: () => void;
		const acquired = new Promise<void>((resolve) => { entered = resolve; });
		const blocker = withSettingsWriteLock(index, () => { entered(); return new Promise<void>((resolve) => { unlock = resolve; }); });
		await acquired;
		const copy = vi.spyOn(fs, "cp");
		const lstat = fs.lstat;
		let changed = false, observedChangedIdentity = false;
		vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
			const metadata = await lstat(...args);
			if (changed && path.basename(String(args[0])) === "selected.txt") {
				observedChangedIdentity = true;
				return Object.assign(Object.create(Object.getPrototypeOf(metadata)), metadata, { ino: 0 });
			}
			return metadata;
		});
		const removal = recoverableRemove(target, { cwd, reason: "racing replacement" }).then(
			(result) => ({ result, error: undefined }), (error: unknown) => ({ result: undefined, error }),
		);
		try {
			// This directory is created after the initial source identity has been captured.
			await vi.waitFor(async () => expect((await fs.stat(path.join(cwd, "backups", "files"))).isDirectory()).toBe(true), { timeout: 5_000 });
			// Native Windows path pinning already prevents an actual rename here.
			// Inject the filesystem identity change to exercise the additional check inside the lock.
			changed = true;
		} finally { unlock(); await blocker; }
		const outcome = await removal;
		expect(outcome.error).toBeInstanceOf(Error);
		expect((outcome.error as Error).message).toContain("Item changed during removal");
		expect(observedChangedIdentity).toBe(true);
		expect(await fs.readFile(target, "utf8")).toBe("original selected contents");
		expect(copy).not.toHaveBeenCalled();
		expect(await fs.readdir(path.join(cwd, "backups", "files"))).toEqual([]);
		await expect(fs.stat(index)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("moves a junction intact into recovery and leaves its target unchanged", async () => {
		const cwd = await setup(); const target = path.join(cwd, "external"); await fs.mkdir(target);
		await fs.writeFile(path.join(target, "keep"), "retained"); const link = path.join(cwd, "alias"); await fs.symlink(target, link, "junction");
		const result = await recoverableRemove(link, { cwd, reason: "test link" });
		expect((await fs.lstat(result.backup)).isSymbolicLink()).toBe(true);
		expect(await fs.readFile(path.join(target, "keep"), "utf8")).toBe("retained");
		expect(await fs.readFile(result.index, "utf8")).toContain(result.backup);
	});
	it("retains the original when the backup cannot be written", async () => {
		const cwd = await setup(); const target = path.join(cwd, "document"); await fs.writeFile(target, "retained");
		vi.spyOn(fs, "cp").mockRejectedValue(new Error("backup unavailable"));
		await expect(recoverableRemove(target, { cwd, reason: "test failure" })).rejects.toThrow("backup unavailable");
		expect(await fs.readFile(target, "utf8")).toBe("retained");
		expect(await fs.readFile(path.join(cwd, "backups", "INDEX.md"), "utf8")).toContain(target);
		expect(await fs.readFile(path.join(cwd, "backups", "INDEX.md"), "utf8")).toContain("未核验，不可作为恢复副本");
	});
	it("copies a directory with nested links and keeps its intact original outside the live path", async () => {
		const cwd = await setup(); const target = path.join(cwd, "bundle"); await fs.mkdir(target);
		const external = path.join(cwd, "external"); await fs.mkdir(external); await fs.writeFile(path.join(external, "keep"), "unchanged");
		await fs.writeFile(path.join(target, "body"), "contents"); await fs.symlink(external, path.join(target, "alias"), "junction");
		const result = await recoverableRemove(target, { cwd, reason: "test nested link" });
		expect(await fs.readFile(path.join(result.backup, "body"), "utf8")).toBe("contents");
		expect(await fs.readFile(path.join(`${result.backup}.original`, "body"), "utf8")).toBe("contents");
		expect(await fs.readFile(path.join(external, "keep"), "utf8")).toBe("unchanged");
	});
	it("refuses a copy whose recovery directory would recurse into its own source", async () => {
		const cwd = await setup(); await fs.writeFile(path.join(cwd, "keep"), "unchanged");
		await expect(createRecoverableCopy(cwd, { cwd, reason: "self copy" })).rejects.toThrow("inside the source");
		expect(await fs.readFile(path.join(cwd, "keep"), "utf8")).toBe("unchanged");
		expect(await fs.stat(path.join(cwd, "backups")).catch(() => null)).toBeNull();
	});
	it("refuses a recovery directory linked back into the source", async () => {
		const cwd = await setup(); const source = path.join(cwd, "bundle"); await fs.mkdir(source);
		await fs.symlink(source, path.join(cwd, "backups"), "junction");
		await expect(createRecoverableCopy(source, { cwd, reason: "linked self copy" })).rejects.toThrow("resolves inside");
		expect(await fs.readdir(source)).toEqual([]);
	});
	it("preserves a private directory's contents and access mode in the verified copy", async () => {
		const cwd = await setup(); const source = path.join(cwd, "private");
		await fs.mkdir(source, { mode: 0o700 }); await fs.writeFile(path.join(source, "document"), "private contents", { mode: 0o600 });
		const result = await createRecoverableCopy(source, { cwd, reason: "private recovery" });
		expect(await fs.readFile(path.join(result.backup, "document"), "utf8")).toBe("private contents");
		if (process.platform !== "win32") expect((await fs.stat(result.backup)).mode & 0o777).toBe((await fs.stat(source)).mode & 0o777);
	});
});
