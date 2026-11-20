import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { APP_ROOT } from "./app-root";
import { BoundaryError, isPathInside, samePath } from "./path-boundary";
import { assertNoRemovalMounts, withProtectedRemovalSource } from "./removal-boundary";

export class TrashUnavailableError extends Error {
	readonly code = "TRASH_UNAVAILABLE";
	constructor(cause?: unknown) {
		super("Cannot move this item to the system Trash. No permanent-delete fallback was attempted.", { cause });
	}
}

export interface TrashOptions {
	/** Trusted, service-selected source boundary; never a client-supplied destination. */
	managedRoot: string;
	expectedLink?: boolean;
	expectedCanonical?: string;
	expectedKind?: "file" | "directory";
	expectedIdentity?: { dev: number; ino: number; size?: number; mtimeMs?: number };
}

type ItemStat = Awaited<ReturnType<typeof fs.lstat>>;
const runFile = promisify(execFile);
// Coercing the leaf to a Finder alias resolves symbolic links and can trash their
// targets. NSFileManager's native Trash API operates on the exact file URL instead.
const MAC_TRASH_SCRIPT = `use framework "Foundation"
on run argv
	set sourceURL to current application's NSURL's fileURLWithPath:(item 1 of argv)
	set {didTrash, trashURL, trashError} to current application's NSFileManager's defaultManager()'s trashItemAtURL:sourceURL resultingItemURL:(reference) |error|:(reference)
	if not (didTrash as boolean) then error (trashError's localizedDescription() as text)
end run`;

async function existing(file: string): Promise<ItemStat | undefined> {
	try { return await fs.lstat(file); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

function unchanged(initial: ItemStat, current: ItemStat): boolean {
	return initial.dev === current.dev && initial.ino === current.ino
		&& initial.isSymbolicLink() === current.isSymbolicLink() && initial.isDirectory() === current.isDirectory();
}

async function physicalDestination(directory: string): Promise<string> {
	let parent = directory;
	const suffix: string[] = [];
	while (!await existing(parent)) { suffix.unshift(path.basename(parent)); parent = path.dirname(parent); }
	return path.join(await fs.realpath(parent), ...suffix);
}

function trashDate(): string {
	const date = new Date();
	const two = (value: number) => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}T${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
}

/** Freedesktop Trash, with an atomic same-filesystem move and .trashinfo for Restore. */
async function trashLinuxItem(removed: string, source: string, stat: ItemStat): Promise<void> {
	const dataHome = process.env.XDG_DATA_HOME && path.isAbsolute(process.env.XDG_DATA_HOME)
		? process.env.XDG_DATA_HOME : path.join(os.homedir(), ".local", "share");
	const declaredTrash = path.join(dataHome, "Trash");
	if ((await existing(declaredTrash))?.isSymbolicLink()) throw new TrashUnavailableError();
	const trash = await physicalDestination(declaredTrash);
	if (isPathInside(removed, trash)) throw new TrashUnavailableError();
	for (const directory of [trash, path.join(trash, "files"), path.join(trash, "info")]) {
		await fs.mkdir(directory, { recursive: true, mode: 0o700 });
		const value = await fs.lstat(directory);
		if (!value.isDirectory() || value.isSymbolicLink() || value.uid !== process.getuid?.()
			|| (value.mode & 0o077) !== 0 || !samePath(await fs.realpath(directory), directory) || value.dev !== stat.dev) {
			// Do not copy across volumes or fall back to unlink on a server without
			// a usable Trash. The source remains in place for the user to handle.
			throw new TrashUnavailableError();
		}
	}
	let prefix = "";
	for (const character of path.basename(removed)) {
		if (Buffer.byteLength(prefix + character) > 180) break;
		prefix += character;
	}
	const name = `${prefix}-${randomUUID()}`;
	const destination = path.join(trash, "files", name);
	const information = path.join(trash, "info", `${name}.trashinfo`);
	const encodedPath = encodeURIComponent(removed).replace(/%2F/gi, "/");
	await withProtectedRemovalSource(information, async (info) => {
		await fs.writeFile(info, `[Trash Info]\nPath=${encodedPath}\nDeletionDate=${trashDate()}\n`, { flag: "wx", mode: 0o600 });
		try {
			await withProtectedRemovalSource(destination, async (target) => {
				if (await existing(target)) throw new TrashUnavailableError();
				if (!unchanged(stat, await fs.lstat(source))) throw new BoundaryError("Item changed during removal; refresh and try again.");
				await fs.rename(source, target);
			});
		} catch (error) {
			// This is only the metadata created by this failed attempt, not user data.
			await fs.unlink(info).catch(() => undefined);
			throw error;
		}
	});
}

/** Confirmed file/directory removal: system Trash only, no backup or permanent-delete fallback. */
export async function moveToTrash(target: string, options: TrashOptions): Promise<{ removed: string }> {
	if (typeof target !== "string" || !path.isAbsolute(target) || target.length > 4096 || target.includes("\0")) throw new BoundaryError("Invalid removal path.");
	const removed = path.resolve(target);
	if (samePath(removed, path.parse(removed).root)) throw new BoundaryError("Cannot remove a filesystem root.");
	const rawRoot = path.resolve(options.managedRoot);
	const declaredRoot = path.join(await fs.realpath(path.dirname(rawRoot)), path.basename(rawRoot));
	const root = options.expectedLink && samePath(removed, declaredRoot) ? declaredRoot : await fs.realpath(rawRoot);
	if (!isPathInside(root, removed) || samePath(root, removed) && !options.expectedLink) throw new BoundaryError("Removal path is outside its managed source.");
	return withProtectedRemovalSource(removed, async (source) => {
		const stat = await fs.lstat(source);
		if (options.expectedLink !== undefined && stat.isSymbolicLink() !== options.expectedLink
			|| !stat.isFile() && !stat.isDirectory() && !stat.isSymbolicLink()
			|| options.expectedKind === "file" && !stat.isFile() && !stat.isSymbolicLink()
			|| options.expectedKind === "directory" && !stat.isDirectory() && !stat.isSymbolicLink()) {
			throw new BoundaryError("Removal type changed; original files were retained.");
		}
		if (options.expectedCanonical && (stat.isSymbolicLink() || !samePath(await fs.realpath(source), options.expectedCanonical))) throw new BoundaryError("Removal target changed; original files were retained.");
		const expected = options.expectedIdentity;
		if (expected && (stat.dev !== expected.dev || stat.ino !== expected.ino
			|| expected.size !== undefined && stat.size !== expected.size || expected.mtimeMs !== undefined && stat.mtimeMs !== expected.mtimeMs)) throw new BoundaryError("Item changed during removal; refresh and try again.");
		await assertNoRemovalMounts(removed, root);
		if (!unchanged(stat, await fs.lstat(source))) throw new BoundaryError("Item changed during removal; refresh and try again.");
		try {
			if (process.platform === "darwin") {
				await runFile("/usr/bin/osascript", ["-e", MAC_TRASH_SCRIPT, removed], { timeout: 60_000 });
			} else if (process.platform === "win32") {
				await runFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", path.join(APP_ROOT, "scripts", "recycle-item.ps1"), "-LiteralPath", removed], { windowsHide: true, timeout: 60_000 });
			} else if (process.platform === "linux") await trashLinuxItem(removed, source, stat);
			else throw new TrashUnavailableError();
		} catch (error) {
			if (error instanceof BoundaryError || error instanceof TrashUnavailableError) throw error;
			throw new TrashUnavailableError(error);
		}
		if (await existing(source)) throw new TrashUnavailableError();
		return { removed };
	});
}
