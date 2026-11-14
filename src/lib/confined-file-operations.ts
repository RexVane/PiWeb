import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { judgeWritePath } from "./permission-gate";
import { readSandboxConfig } from "./sandbox/config";
import { windowsFileOperation } from "./sandbox/windows-file-operations";
import type { ToolPreset } from "./types";

/** Linux directory descriptors pin the entire traversal; a renamed junction cannot redirect it. */
async function linuxOperation(root: string, target: string, operation: "write" | "mkdir", content?: string): Promise<void> {
	const relative = path.relative(root, target);
	const parts = relative.split(path.sep).filter(Boolean);
	const directoryParts = operation === "mkdir" ? parts : parts.slice(0, -1);
	const handles: fs.FileHandle[] = [];
	try {
		let directory = await fs.open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
		handles.push(directory);
		for (const part of directoryParts) {
			const entry = `/proc/self/fd/${directory.fd}/${part}`;
			await fs.mkdir(entry).catch((error) => { if (error.code !== "EEXIST") throw error; });
			directory = await fs.open(entry, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
			handles.push(directory);
		}
		if (operation === "mkdir") return;
		const parent = `/proc/self/fd/${directory.fd}`;
		const destination = `${parent}/${parts.at(-1)}`;
		const stat = await fs.lstat(destination).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
		if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1)) throw new Error("blocked: linked or non-regular write target");
		const temporary = `${parent}/.piweb-write-${randomUUID()}`;
		try {
			await fs.writeFile(temporary, content ?? "", { flag: "wx", mode: stat ? stat.mode & 0o777 : 0o600 });
			await fs.rename(temporary, destination);
		} finally { await fs.unlink(temporary).catch(() => undefined); }
	} finally { await Promise.all(handles.map((handle) => handle.close())); }
}

/**
 * 既没有 Linux 的目录句柄、也没有 Windows 沙箱的平台（macOS 等）：只有路径级保证。
 * 目标已由 judgeWritePath 按 realpath 判定在工作区内；这里再做与受限后端相同的目标检查并原子替换，
 * 但检查与写入之间的窗口不由内核钉住，不能当成 OS 级隔离。
 */
async function pathLevelOperation(target: string, operation: "write" | "mkdir", content?: string): Promise<void> {
	if (operation === "mkdir") { await fs.mkdir(target, { recursive: true }); return; }
	const stat = await fs.lstat(target).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
	if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1)) throw new Error("blocked: linked or non-regular write target");
	const temporary = path.join(path.dirname(target), `.piweb-write-${randomUUID()}`);
	try {
		await fs.writeFile(temporary, content ?? "", { flag: "wx", mode: stat ? stat.mode & 0o777 : 0o600 });
		await fs.rename(temporary, target);
	} finally { await fs.unlink(temporary).catch(() => undefined); }
}

export function createConfinedFileOperations(context: { sessionPath: string; cwd: string; preset: () => ToolPreset }) {
	const perform = async (operation: "write" | "mkdir", target: string, content?: string) => {
		const preset = context.preset();
		if (preset === "full") {
			if (operation === "mkdir") await fs.mkdir(target, { recursive: true });
			else await fs.writeFile(target, content ?? "", "utf8");
			return;
		}
		if (preset === "readonly") throw new Error("blocked: this session is readonly");
		const extraRoots = (await readSandboxConfig()).additionalWritableRoots;
		const verdict = await judgeWritePath(context.cwd, target, extraRoots);
		if (!verdict.inside || context.preset() !== preset) throw new Error("blocked: write target is outside the active workspace boundary");
		if (process.platform === "linux") return linuxOperation(verdict.root, verdict.resolved, operation, content);
		// Windows pins directories directly; file tools do not depend on shell availability.
		if (process.platform !== "win32") return pathLevelOperation(verdict.resolved, operation, content);
		return windowsFileOperation(verdict.root, verdict.resolved, operation, content, () => {
			if (context.preset() !== preset) throw new Error("blocked: the permission preset changed before the file operation");
		});
	};
	return {
		writeFile: (target: string, content: string) => perform("write", target, content),
		mkdir: (target: string) => perform("mkdir", target),
		readFile: (target: string) => fs.readFile(target),
		access: (target: string) => fs.access(target, constants.R_OK),
	};
}
