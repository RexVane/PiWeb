import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ChildProcess, ExecFileOptions } from "node:child_process";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { recycleGeneratedFixture } from "./fixtures/system-trash";

const native = vi.hoisted(() => ({
	group: "", trash: "", mode: "move" as "move" | "fail" | "noop", moved: [] as string[],
	calls: [] as Array<{ command: string; args: string[] }>,
	mounts: vi.fn(async (_target: string, _root: string) => {}),
}));
vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return { ...actual, execFile: (command: string, args: string[], options: ExecFileOptions, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
		// Generated fixture cleanup really uses Finder; the product's native calls
		// are otherwise simulated and can never access a user's real Trash/data.
		if (command === "/usr/bin/osascript" && args.some((arg) => arg.includes('tell application "Finder"'))) return actual.execFile(command, args, options, (error, stdout, stderr) => callback(error, String(stdout), String(stderr)));
		native.calls.push({ command, args });
		const target = args.at(-1)!;
		void (async () => {
			if (!target.startsWith(native.group + path.sep)) throw new Error("Test recycler escaped its generated fixtures.");
			if (native.mode === "fail") throw Object.assign(new Error("native command unavailable"), { code: "ENOENT" });
			if (native.mode === "move") {
				const destination = path.join(native.trash, `${randomUUID()}-${path.basename(target)}`);
				await fs.rename(target, destination); native.moved.push(destination);
			}
		})().then(() => callback(null, "", ""), (error: Error) => callback(error, "", ""));
		return {} as ChildProcess;
	} };
});
vi.mock("@/lib/removal-boundary", () => ({
	assertNoRemovalMounts: native.mounts,
	withProtectedRemovalSource: async <T,>(target: string, action: (source: string) => Promise<T>) => action(target),
}));
import { moveToTrash, TrashUnavailableError } from "@/lib/recycle-bin";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const setPlatform = (value: string) => Object.defineProperty(process, "platform", { configurable: true, value });
let directory: string, root: string, file: string;
beforeAll(async () => { native.group = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "piweb-system-trash-tests-"))); });
afterAll(async () => { await recycleGeneratedFixture(native.group); });
beforeEach(async () => {
	directory = await fs.mkdtemp(path.join(native.group, "case-")); root = path.join(directory, "managed"); file = path.join(root, "template.md"); native.trash = path.join(directory, "test-native-trash");
	for (const entry of [root, native.trash]) await fs.mkdir(entry);
	await fs.writeFile(file, "original template"); native.calls = []; native.moved = []; native.mode = "move"; native.mounts.mockReset().mockResolvedValue();
});
afterEach(() => { Object.defineProperty(process, "platform", platform); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("system Trash boundary and native protocol", () => {
	it("uses macOS's file-URL Trash API with the path as an argument, not an interpolated alias", async () => {
		setPlatform("darwin"); const quoted = path.join(root, "quoted' \" 中文\n.md"); await fs.rename(file, quoted);
		await expect(moveToTrash(quoted, { managedRoot: root, expectedCanonical: quoted, expectedLink: false })).resolves.toEqual({ removed: quoted });
		expect(native.calls).toHaveLength(1); expect(native.calls[0].command).toBe("/usr/bin/osascript");
		expect(native.calls[0].args.at(-1)).toBe(quoted);
		expect(native.calls[0].args[1]).toContain("trashItemAtURL:sourceURL"); expect(native.calls[0].args[1]).not.toContain(quoted);
		expect(await fs.readFile(native.moved[0], "utf8")).toBe("original template");
		await expect(fs.stat(path.join(directory, "backups"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("moves a link intact, without touching its outside target", async () => {
		setPlatform("darwin"); const external = path.join(directory, "external.md"), alias = path.join(root, "alias.md");
		await fs.writeFile(external, "outside target");
		try { await fs.symlink(external, alias, "file"); } catch (error) { if (["EPERM", "EACCES", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code || "")) return; throw error; }
		await moveToTrash(alias, { managedRoot: root, expectedLink: true });
		expect((await fs.lstat(native.moved[0])).isSymbolicLink()).toBe(true); expect(await fs.readFile(external, "utf8")).toBe("outside target");
	});

	it("recycles a whole directory as one item, without traversing its links", async () => {
		setPlatform("darwin"); const directory = path.join(root, "skill"); await fs.mkdir(directory); await fs.writeFile(path.join(directory, "SKILL.md"), "skill body");
		await moveToTrash(directory, { managedRoot: root, expectedKind: "directory", expectedCanonical: directory, expectedLink: false });
		expect(native.calls).toHaveLength(1); expect(await fs.readFile(path.join(native.moved[0], "SKILL.md"), "utf8")).toBe("skill body");
	});

	it("rejects a wrong source boundary, root directory, type or identity before native recycling", async () => {
		setPlatform("darwin");
		await expect(moveToTrash(file, { managedRoot: native.trash })).rejects.toThrow("outside");
		await expect(moveToTrash(root, { managedRoot: root })).rejects.toThrow("outside");
		await expect(moveToTrash(file, { managedRoot: root, expectedKind: "directory" })).rejects.toThrow("type changed");
		const stat = await fs.lstat(file);
		await expect(moveToTrash(file, { managedRoot: root, expectedIdentity: { dev: stat.dev, ino: stat.ino + 1 } })).rejects.toThrow("changed");
		expect(native.calls).toEqual([]); expect(await fs.readFile(file, "utf8")).toBe("original template");
	});

	it("rejects a file replaced by a symbolic link after planning", async () => {
		setPlatform("darwin"); const external = path.join(directory, "external.md"); await fs.writeFile(external, "external");
		await fs.rename(file, `${file}.original`);
		try { await fs.symlink(external, file, "file"); } catch (error) { if (["EPERM", "EACCES", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code || "")) return; throw error; }
		await expect(moveToTrash(file, { managedRoot: root, expectedCanonical: file, expectedLink: false })).rejects.toThrow("type changed");
		expect(native.calls).toEqual([]); expect(await fs.readFile(external, "utf8")).toBe("external");
	});

	it("keeps mounted entries in place rather than handing them to a directory recycler", async () => {
		setPlatform("darwin"); native.mounts.mockRejectedValueOnce(new Error("mounted source"));
		await expect(moveToTrash(file, { managedRoot: root })).rejects.toThrow("mounted");
		expect(native.calls).toEqual([]); expect(await fs.readFile(file, "utf8")).toBe("original template");
	});

	it.each(["fail", "noop"] as const)("retains an item on a %s native operation without unlink fallback", async (mode) => {
		setPlatform("darwin"); native.mode = mode;
		await expect(moveToTrash(file, { managedRoot: root })).rejects.toBeInstanceOf(TrashUnavailableError);
		expect(await fs.readFile(file, "utf8")).toBe("original template"); expect(native.calls).toHaveLength(1);
	});

	it("uses Windows's explicit recycle operation and passes a literal path", async () => {
		setPlatform("win32"); await moveToTrash(file, { managedRoot: root, expectedLink: false });
		expect(native.calls[0].command).toBe("powershell.exe"); expect(native.calls[0].args).toContain("-STA");
		expect(native.calls[0].args.slice(-2)).toEqual(["-LiteralPath", file]);
		const script = await fs.readFile(path.resolve("scripts/recycle-item.ps1"), "utf8");
		expect(script).toContain("FOFX_RECYCLEONDELETE"); expect(script).toContain("NukeOnDelete");
		expect(script).not.toContain("Remove-Item -"); expect(script).not.toContain("DeletePermanently");
	});

	it.skipIf(platform.value === "win32")("creates restorable freedesktop metadata in an isolated XDG Trash", async () => {
		setPlatform("linux"); vi.stubEnv("XDG_DATA_HOME", path.join(directory, "data-home"));
		await moveToTrash(file, { managedRoot: root, expectedCanonical: file, expectedLink: false });
		const trash = path.join(directory, "data-home", "Trash"), name = (await fs.readdir(path.join(trash, "files")))[0];
		expect(await fs.readFile(path.join(trash, "files", name), "utf8")).toBe("original template");
		const metadata = await fs.readFile(path.join(trash, "info", `${name}.trashinfo`), "utf8");
		expect(metadata).toContain(`Path=${encodeURIComponent(file).replace(/%2F/gi, "/")}`); expect(metadata).toMatch(/DeletionDate=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
		expect(native.calls).toEqual([]);
	});

	it.skipIf(platform.value === "win32")("recycles a long filename without overflowing the Trash metadata filename", async () => {
		setPlatform("linux"); vi.stubEnv("XDG_DATA_HOME", path.join(directory, "data-home"));
		const long = path.join(root, `${"x".repeat(230)}.md`); await fs.rename(file, long);
		await moveToTrash(long, { managedRoot: root, expectedLink: false, expectedCanonical: long });
		const trash = path.join(directory, "data-home", "Trash"), name = (await fs.readdir(path.join(trash, "files")))[0];
		expect(Buffer.byteLength(`${name}.trashinfo`)).toBeLessThan(255);
		expect(await fs.readFile(path.join(trash, "files", name), "utf8")).toBe("original template");
	});

	it.skipIf(platform.value === "win32")("rejects a linked or public Linux Trash directory and retains the source", async () => {
		setPlatform("linux"); const data = path.join(directory, "data"); await fs.mkdir(data);
		vi.stubEnv("XDG_DATA_HOME", data); await fs.symlink(native.trash, path.join(data, "Trash"), "dir");
		await expect(moveToTrash(file, { managedRoot: root })).rejects.toBeInstanceOf(TrashUnavailableError);
		expect(await fs.readFile(file, "utf8")).toBe("original template");
		const publicData = path.join(directory, "public-data"); await fs.mkdir(path.join(publicData, "Trash"), { recursive: true, mode: 0o777 });
		await fs.chmod(path.join(publicData, "Trash"), 0o777); vi.stubEnv("XDG_DATA_HOME", publicData);
		await expect(moveToTrash(file, { managedRoot: root })).rejects.toBeInstanceOf(TrashUnavailableError);
		expect(await fs.readFile(file, "utf8")).toBe("original template");
	});

	it("never substitutes permanent deletion on an unsupported operating system", async () => {
		setPlatform("unsupported"); await expect(moveToTrash(file, { managedRoot: root })).rejects.toBeInstanceOf(TrashUnavailableError);
		expect(await fs.readFile(file, "utf8")).toBe("original template"); expect(native.calls).toEqual([]);
	});
});
