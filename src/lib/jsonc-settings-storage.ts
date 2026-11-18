import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import lockfile from "proper-lockfile";
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";
// 叶子模块：BoundaryError/samePath 从 path-boundary 取，避免
// pi → jsonc-settings-storage → path-security → pi 的 import 循环。
import { BoundaryError, samePath } from "./path-boundary";
import { syncDirectorySync, syncFileSync } from "./atomic-file";
import { windowsDirectoryApiSync } from "./windows-directory-api";

const MAX_BYTES = 1024 * 1024;
const sleeper = new Int32Array(new SharedArrayBuffer(4));
function pause(ms: number): void { Atomics.wait(sleeper, 0, 0, ms); }
interface SettingsBoundary { projectRoot?: string }
function projectFile(file: string, boundary?: SettingsBoundary): string {
	if (!boundary?.projectRoot) return file;
	const root = fs.realpathSync(path.resolve(boundary.projectRoot));
	const relative = path.relative(path.resolve(boundary.projectRoot), path.resolve(file));
	if (relative !== path.join(".pi", "settings.json")) throw new BoundaryError("invalid project settings path");
	const target = path.join(root, relative);
	try {
		const directory = path.dirname(target);
		const stat = fs.lstatSync(directory);
		if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(fs.realpathSync(directory), directory)) throw new BoundaryError("project .pi settings directory must not be a link");
	} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	return target;
}

function readBounded(file: string, boundary?: SettingsBoundary): string | undefined {
	let fd: number;
	let before: fs.Stats | undefined;
	if (boundary?.projectRoot) {
		try { before = fs.lstatSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		if (before && (!before.isFile() || before.isSymbolicLink() || before.nlink > 1)) throw new BoundaryError("project settings file must not be linked");
	}
	try { fd = fs.openSync(file, "r"); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
	try {
		const stat = fs.fstatSync(fd);
		if (boundary?.projectRoot) {
			const real = fs.realpathSync(file);
			const current = fs.statSync(real);
			if (!before || !samePath(real, file) || stat.ino !== before.ino || stat.dev !== before.dev || stat.ino !== current.ino || stat.dev !== current.dev) throw new BoundaryError("project settings changed while opening");
		}
		if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error("Settings source exceeds the supported size limit");
		const parts: Buffer[] = [];
		let offset = 0;
		while (offset <= MAX_BYTES) {
			const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_BYTES + 1 - offset));
			const count = fs.readSync(fd, chunk, 0, chunk.length, offset);
			if (!count) break;
			offset += count;
			parts.push(chunk.subarray(0, count));
		}
		if (offset > MAX_BYTES) throw new Error("Settings source grew beyond the supported size limit");
		return Buffer.concat(parts, offset).toString("utf8");
	} finally { fs.closeSync(fd); }
}
function objectFrom(text: string): Record<string, unknown> {
	const errors: ParseError[] = [];
	const value = parse(text.replace(/^\uFEFF/, ""), errors, { allowTrailingComma: true });
	if (errors.length || !value || typeof value !== "object" || Array.isArray(value)) throw new Error("Settings source must contain a valid JSON object");
	return value as Record<string, unknown>;
}
export function readJsoncSettingsObjectSync(file: string, boundary?: SettingsBoundary): Record<string, unknown> {
	const value = readBounded(projectFile(file, boundary), boundary);
	return value === undefined ? {} : objectFrom(value);
}
function edit(original: string, before: Record<string, unknown>, after: Record<string, unknown>): string {
	let text = original.replace(/^\uFEFF/, "");
	const visit = (a: Record<string, unknown>, b: Record<string, unknown>, prefix: string[]) => {
		for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
			if (JSON.stringify(a[key]) === JSON.stringify(b[key])) continue;
			const av = a[key], bv = b[key];
			if (av && bv && typeof av === "object" && typeof bv === "object" && !Array.isArray(av) && !Array.isArray(bv)) visit(av as Record<string, unknown>, bv as Record<string, unknown>, [...prefix, key]);
			else text = applyEdits(text, modify(text, [...prefix, key], bv, { formattingOptions: { insertSpaces: false, tabSize: 1 } }));
		}
	};
	visit(before, after, []);
	return (original.startsWith("\uFEFF") ? "\uFEFF" : "") + text;
}
/** Public SettingsManager.fromStorage adapter; SDK receives JSON while user formatting stays on disk. */
export class JsoncSettingsStorage {
	constructor(private cwd: string, private agentDir: string) {}
	withLock(scope: "global" | "project", fn: (current: string | undefined) => string | undefined): void {
		const file = scope === "global" ? path.join(this.agentDir, "settings.json") : path.join(this.cwd, ".pi", "settings.json");
		withJsoncSettingsFileSync(file, fn, scope === "project" ? { projectRoot: this.cwd } : undefined);
	}
}

/** Keep manual edits and SDK writes in synchronous, non-interleaving critical sections. */
export function mutateJsoncSettingsFileSync(file: string, transform: (current: Record<string, unknown>) => Record<string, unknown> | undefined, boundary?: SettingsBoundary): void {
	withJsoncSettingsFileSync(file, (text) => {
		const next = transform(text === undefined ? {} : objectFrom(text));
		return next === undefined ? undefined : JSON.stringify(next);
	}, boundary);
}

function withProjectWriteDirectory<T>(file: string, boundary: SettingsBoundary | undefined, action: (rename: (temporary: string) => void) => T): T {
	if (!boundary?.projectRoot) {
		let api: ReturnType<typeof windowsDirectoryApiSync> | undefined;
		if (process.platform === "win32") { try { api = windowsDirectoryApiSync(); } catch { /* Global settings do not require a native project boundary. */ } }
		return action((temporary) => api ? api.rename(temporary, path.basename(file)) : fs.renameSync(temporary, file));
	}
	const directory = path.dirname(file);
	if (process.platform !== "win32") {
		fs.mkdirSync(directory, { recursive: true });
		projectFile(file, { projectRoot: path.dirname(directory) });
		return action((temporary) => fs.renameSync(temporary, file));
	}
	const api = windowsDirectoryApiSync();
	const volume = path.parse(file).root;
	if (!/^[a-z]:\\$/i.test(volume)) throw new BoundaryError("project settings require a local drive");
	const handles: unknown[] = [];
	try {
		let current = volume;
		handles.push(api.pin(current));
		for (const segment of path.relative(volume, directory).split(path.sep).filter(Boolean)) {
			current = path.join(current, segment);
			if (current === directory) fs.mkdirSync(current, { recursive: true });
			handles.push(api.pin(current));
		}
		return action((temporary) => api.rename(temporary, path.basename(file)));
	} finally { for (const handle of handles.reverse()) api.close(handle); }
}

function withJsoncSettingsFileSync(file: string, fn: (current: string | undefined) => string | undefined, boundary?: SettingsBoundary): void {
	try { file = projectFile(file, boundary); }
	catch (error) {
		// Cached SDK managers can outlive a removed workspace. Reading its absent
		// settings is valid; a write must never silently recreate the workspace.
		if (boundary?.projectRoot && (error as NodeJS.ErrnoException).code === "ENOENT" && fn(undefined) === undefined) return;
		throw error;
	}
	// SDK reads use the same callback contract, but must not create a missing .pi
	// directory or require a native write backend. All mutating callbacks are pure
	// merges and are repeated under the cross-process lock before committing.
	const initial = readBounded(file, boundary);
	if (fn(initial === undefined ? undefined : JSON.stringify(objectFrom(initial))) === undefined) return;
	withProjectWriteDirectory(file, boundary, (rename) => {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		let release: (() => void) | undefined;
		try {
			for (let attempt = 0; ; attempt++) {
				try { release = lockfile.lockSync(file, { realpath: false }); break; }
				catch (error) { if ((error as NodeJS.ErrnoException).code !== "ELOCKED" || attempt >= 9) throw error; pause(20); }
			}
			const original = readBounded(file, boundary);
			const before = original === undefined ? {} : objectFrom(original);
			const next = fn(original === undefined ? undefined : JSON.stringify(before));
			if (next === undefined) return;
			const result = edit(original ?? "{}\n", before, objectFrom(next));
			if (Buffer.byteLength(result) > MAX_BYTES) throw new Error("Settings output exceeds the supported size limit");
			const temporary = file + "." + randomUUID() + ".tmp";
			// no-unsafe-finally（K1）：finally 里 throw/return 会顶掉主错误；清理与主操作分开记录，
			// 清理失败仍按原语义优先抛出。
			let writeError: unknown;
			try {
				fs.writeFileSync(temporary, result, { encoding: "utf8", mode: 0o600, flag: "wx" });
				// 断电持久性（D3）：rename 发布前先把内容刷盘，发布后刷目录项（不可用时降级）。
				syncFileSync(temporary);
				for (let attempt = 0; ; attempt++) {
					try { rename(temporary); break; }
					catch (error) { if (!["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "") || attempt >= 9) throw error; pause(Math.min(25 * (attempt + 1), 100)); }
				}
				syncDirectorySync(path.dirname(file));
			} catch (error) {
				writeError = error;
			}
			let cleanupError: unknown;
			try { fs.unlinkSync(temporary); }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") cleanupError = error; }
			if (cleanupError !== undefined) throw cleanupError;
			if (writeError !== undefined) throw writeError;
		} finally { release?.(); }
	});
}
