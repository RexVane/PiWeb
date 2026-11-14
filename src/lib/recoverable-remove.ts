import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { withSettingsWriteLock, withExternalSettingsLock } from "./settings-write-lock";
import { assertNoRemovalMounts, withProtectedRemovalSource } from "./removal-boundary";

export interface RecoverableRemoveOptions {
	/** A trusted workspace, never a client-provided deletion destination. */
	cwd?: string;
	reason: string;
	/** Canonical target captured by the skill deletion plan, before any backup I/O. */
	expectedCanonical?: string;
	expectedLink?: boolean;
	managedRoot?: string;
}

function inside(target: string, root: string): boolean {
	const relative = path.relative(root, target);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/** Resolve existing ancestors before mkdir so a linked recovery root cannot mutate the source. */
async function canonicalDestination(target: string): Promise<string> {
	let ancestor = target;
	const suffix: string[] = [];
	for (;;) {
		try { return path.join(await fs.realpath(ancestor), ...suffix); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			const parent = path.dirname(ancestor);
			if (parent === ancestor) throw error;
			suffix.unshift(path.basename(ancestor)); ancestor = parent;
		}
	}
}

const runFile = promisify(execFile);

async function copyPreservingLinks(source: string, destination: string): Promise<void> {
	const stat = await fs.lstat(source);
	if (stat.isSymbolicLink()) {
		const link = await fs.readlink(source);
		const directory = await fs.stat(source).then((target) => target.isDirectory(), () => false);
		await fs.symlink(link, destination, process.platform === "win32" && directory ? "junction" : directory ? "dir" : "file");
	} else if (stat.isDirectory()) {
		await fs.mkdir(destination, { mode: 0o700 });
		for (const child of await fs.readdir(source)) await copyPreservingLinks(path.join(source, child), path.join(destination, child));
		if (process.platform !== "win32") await fs.chmod(destination, stat.mode & 0o7777);
	} else {
		await fs.cp(source, destination, { preserveTimestamps: true, force: false, errorOnExist: true });
	}
}

async function fingerprint(target: string): Promise<{ entries: string[]; links: boolean }> {
	const entries: string[] = [];
	let links = false;
	const visit = async (file: string) => {
		const stat = await fs.lstat(file);
		const relative = path.relative(target, file);
		if (stat.isSymbolicLink()) {
			links = true;
			entries.push(`${relative}:link:${await fs.readlink(file)}`);
		} else if (stat.isDirectory()) {
			entries.push(`${relative}:directory`);
			for (const child of (await fs.readdir(file)).sort()) await visit(path.join(file, child));
		} else {
			const hash = createHash("sha256");
			const handle = await fs.open(file, "r");
			try {
				const buffer = Buffer.alloc(64 * 1024);
				for (;;) {
					const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
					if (!bytesRead) break;
					hash.update(buffer.subarray(0, bytesRead));
				}
			} finally { await handle.close(); }
			entries.push(`${relative}:file:${stat.size}:${hash.digest("hex")}`);
		}
	};
	await visit(target);
	return { entries, links };
}

/** Copy and index data before recycling it. Links are moved intact, without touching their targets. */
export async function recoverableRemove(target: string, options: RecoverableRemoveOptions): Promise<{ removed: string; backup: string; index: string }> {
	const removed = path.resolve(target);
	return withProtectedRemovalSource(removed, (source) => recoverableRemovePinned(removed, source, options));
}

async function recoverableRemovePinned(removed: string, source: string, options: RecoverableRemoveOptions): Promise<{ removed: string; backup: string; index: string }> {
	const metadata = await fs.lstat(source);
	if (options.expectedLink !== undefined && metadata.isSymbolicLink() !== options.expectedLink) throw new Error("Skill removal type changed; original files were retained.");
	if (options.expectedCanonical && (metadata.isSymbolicLink() || await fs.realpath(source) !== options.expectedCanonical)) throw new Error("Skill target changed during removal; original files were retained.");
	await assertNoRemovalMounts(removed, options.managedRoot);
	const home = path.resolve(os.homedir());
	const workspace = options.cwd ? path.resolve(options.cwd) : undefined;
	let root: string;
	if (workspace && inside(removed, workspace)) root = path.join(workspace, "backups");
	else if (inside(removed, home)) root = path.join(home, ".agents", "backups");
	else root = path.join(path.dirname(removed), "backups");
	if (inside(root, removed)) throw new Error("Recovery directory cannot be inside the item being removed");
	const mirror = inside(removed, home) && !(workspace && inside(removed, workspace))
		? path.dirname(path.relative(home, removed)) : "files";
	const directory = path.join(root, mirror);
	const canonicalTarget = metadata.isSymbolicLink() ? removed : await fs.realpath(source);
	if (inside(await canonicalDestination(directory), canonicalTarget)) throw new Error("Recovery directory resolves inside the item being removed");
	await fs.mkdir(directory, { recursive: true });
	// Reject a recovery-root link into the item itself before moving any data.
	const canonicalDirectory = await fs.realpath(directory);
	if (inside(canonicalDirectory, canonicalTarget)) throw new Error("Recovery directory resolves inside the item being removed");
	const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/T/, "-").slice(0, 15);
	const name = path.parse(removed);
	const backup = path.join(directory, `${name.name}-${timestamp}-${randomUUID().slice(0, 8)}${name.ext}`);
	const index = path.join(root, "INDEX.md");
	const clean = (value: string) => value.replace(/[\r\n|]/g, " ");
	await withSettingsWriteLock(index, () => withExternalSettingsLock(index, async () => {
		const current = await fs.lstat(source);
		if (current.dev !== metadata.dev || current.ino !== metadata.ino || current.isSymbolicLink() !== metadata.isSymbolicLink()) {
			throw new Error("Item changed during removal; refresh and try again");
		}
		const original = await fingerprint(source);
		try {
			if (!metadata.isSymbolicLink()) {
				await copyPreservingLinks(source, backup);
				const copied = await fingerprint(backup);
				if (JSON.stringify(copied.entries) !== JSON.stringify(original.entries)) throw new Error("Recovery copy could not be verified; original was retained");
				if (JSON.stringify((await fingerprint(source)).entries) !== JSON.stringify(original.entries)) throw new Error("Item changed while backing up; original was retained");
			}
		} catch (error) {
			await fs.appendFile(index, `${new Date().toISOString()} | ${clean(removed)} | ${clean(backup)}（未核验，不可作为恢复副本） | 备份失败，原件保留\n`, "utf8").catch(() => undefined);
			throw error;
		}
		await fs.appendFile(index, `${new Date().toISOString()} | ${clean(removed)} | ${clean(backup)} | ${clean(options.reason)}\n`, "utf8");
		try {
			await assertNoRemovalMounts(removed, options.managedRoot);
			const final = await fs.lstat(source);
			if (final.dev !== metadata.dev || final.ino !== metadata.ino || final.isSymbolicLink() !== metadata.isSymbolicLink()) throw new Error("Item changed while backing up; original was retained");
			if (metadata.isSymbolicLink()) {
				// Directory recyclers differ in how they traverse reparse points. Keep
				// the link itself in recovery instead of invoking a recursive recycler.
				await fs.rename(source, backup);
			} else if (metadata.isDirectory() || original.links || process.platform !== "win32") {
				const intact = `${backup}.original`;
				await fs.appendFile(index, `${new Date().toISOString()} | ${clean(removed)} | ${clean(intact)} | 保留原件及链接\n`, "utf8");
				await fs.rename(source, intact);
			} else {
				const method = metadata.isDirectory() ? "DeleteDirectory" : "DeleteFile";
				const literal = removed.replace(/'/g, "''");
				const script = `$ErrorActionPreference = 'Stop'; Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::${method}('${literal}', 'OnlyErrorDialogs', 'SendToRecycleBin')`;
				await runFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true, timeout: 60_000 });
			}
		} catch (error) {
			await fs.appendFile(index, `${new Date().toISOString()} | ${clean(removed)} | 未移除，原件保留 | 移动失败\n`, "utf8").catch(() => undefined);
			throw error;
		}
	}));
	return { removed, backup, index };
}

/** Preserve an indexed copy without removing or overwriting the source. */
export async function createRecoverableCopy(target: string, options: RecoverableRemoveOptions): Promise<{ backup: string; index: string }> {
	const source = path.resolve(target); const home = path.resolve(os.homedir());
	const workspace = options.cwd ? path.resolve(options.cwd) : undefined;
	const root = workspace && inside(source, workspace) ? path.join(workspace, "backups")
		: inside(source, home) ? path.join(home, ".agents", "backups") : path.join(path.dirname(source), "backups");
	const directory = path.join(root, inside(source, home) && !(workspace && inside(source, workspace)) ? path.dirname(path.relative(home, source)) : "files");
	if (inside(root, source)) throw new Error("Recovery directory cannot be inside the source being backed up");
	if (inside(await canonicalDestination(directory), await fs.realpath(source))) throw new Error("Recovery directory resolves inside the source being backed up");
	await fs.mkdir(directory, { recursive: true });
	if (inside(await fs.realpath(directory), await fs.realpath(source))) throw new Error("Recovery directory resolves inside the source being backed up");
	const parsed = path.parse(source); const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
	const backup = path.join(directory, `${parsed.name}-${stamp}-${randomUUID().slice(0, 8)}${parsed.ext}`); const index = path.join(root, "INDEX.md");
	const clean = (value: string) => value.replace(/[\r\n|]/g, " ");
	await withSettingsWriteLock(index, () => withExternalSettingsLock(index, async () => {
		try {
			const original = await fingerprint(source); await copyPreservingLinks(source, backup);
			if (JSON.stringify(original.entries) !== JSON.stringify((await fingerprint(backup)).entries)
				|| JSON.stringify(original.entries) !== JSON.stringify((await fingerprint(source)).entries)) throw new Error("Recovery copy verification failed; source was retained");
		} catch (error) {
			await fs.appendFile(index, `${new Date().toISOString()} | ${clean(source)} | ${clean(backup)}（未核验，不可作为恢复副本） | 备份失败，原件保留\n`, "utf8").catch(() => undefined);
			throw error;
		}
		await fs.appendFile(index, `${new Date().toISOString()} | ${clean(source)} | ${clean(backup)} | ${clean(options.reason)}\n`, "utf8");
	}));
	return { backup, index };
}
