/**
 * files-service：会话工作区的文件浏览（详情栏「文件」面板）。
 * 安全边界：目标路径必须落在工作区根内（realpath 双重校验，防符号链接逃逸）。
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { BoundaryError, isPathInside, resolveWorkspacePath, samePath } from "./path-security";
import { getAgentDir } from "./pi";
import { resolveGitBin } from "./growth-service";
import { decodeFilePreview, type DecodedFilePreview } from "./file-preview";
import { StringDecoder } from "node:string_decoder";
import { recoverableRemove } from "./recoverable-remove";
import { childProcessEnv } from "./child-process-env";

export interface FileEntry {
	name: string;
	kind: "dir" | "file";
	size?: number;
}

export interface DirListing {
	/** 工作区根下的相对路径（"/" 分隔；根目录为 "."） */
	dir: string;
	entries: FileEntry[];
	/** 单目录分页；客户端可继续拉取，直到 nextOffset 为 null。 */
	nextOffset: number | null;
	truncated: boolean;
}

/** 文本预览上限：256 KB——详情栏预览用，不是文件编辑器 */
const MAX_READ_BYTES = 256 * 1024;
/** 单次目录响应上限；后续条目通过 offset 分页获取。 */
const MAX_ENTRIES = 2000;

/**
 * @ 引用的候选索引上限。一次拉给浏览器做本地模糊匹配，所以是一份完整清单：
 * 每敲一个字符不再发请求（实测本仓库 700 余条 ≈ 30 KB）。
 * 超大仓库截断到上限并在界面标出，不静默少候选。
 */
const INDEX_LIMIT = 20_000;
/** 非 git 工作区的退路：只跳过这些明显不该当候选的重目录，其余照常列举 */
const INDEX_SKIP_DIRS = new Set([".git", "node_modules", ".next", ".next-dev", ".venv", "venv", "__pycache__", "dist", "build", "out", "target", ".turbo", ".cache"]);
const INDEX_MAX_DEPTH = 12;
const SAFE_GIT_ARGS = ["-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "-c", "core.hooksPath="];
function gitEnvironment(root: string): NodeJS.ProcessEnv {
	const env = { ...process.env };
	for (const key of Object.keys(env)) if (/^GIT_(?:DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|CONFIG(?:_|$))/.test(key)) delete env[key];
	return { ...env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_CEILING_DIRECTORIES: path.dirname(root), LC_ALL: "C" };
}
const indexCache = new Map<string, { at: number; stamp: string; promise: Promise<WorkspaceIndex> }>();
const INDEX_CACHE_MS = 2000;

export interface WorkspaceIndex {
	/** 工作区根下的相对路径（"/" 分隔）。只给文件：文件夹由前端从文件路径推导 */
	files: string[];
	/** git = `git ls-files`（尊重 .gitignore）；disk = 不是仓库时的目录遍历退路 */
	source: "git" | "disk";
	/** 候选被上限截断：匹配结果可能不全，界面要说明 */
	truncated: boolean;
	warning?: string;
}

/** `git ls-files -z` 输出 → 相对路径数组（去重） */
export function parseLsFiles(raw: string): string[] {
	const seen = new Set<string>();
	for (const entry of raw.split("\0")) {
		if (!entry) continue;
		const rel = entry.replace(/\\/g, "/");
		if (rel.startsWith("/") || rel.split("/").includes("..")) continue;
		seen.add(rel);
	}
	return [...seen];
}

/** 不是仓库（或机器上没有 git）时的退路：广度优先遍历，只收文件 */
async function walkWorkspaceFiles(root: string): Promise<{ files: string[]; truncated: boolean }> {
	const files: string[] = [];
	let truncated = false, visited = 0;
	const deadline = performance.now() + 5000;
	let queue: Array<{ rel: string; depth: number }> = [{ rel: "", depth: 0 }];
	while (queue.length) {
		const next: typeof queue = [];
		for (const dir of queue) {
			if (++visited > 50_000 || performance.now() >= deadline) return { files, truncated: true };
			const entries = await fs.opendir(path.join(root, dir.rel)).catch(() => null);
			if (!entries) { truncated = true; continue; }
			try { for await (const entry of entries) {
				if (performance.now() >= deadline) return { files, truncated: true };
				const rel = dir.rel ? `${dir.rel}/${entry.name}` : entry.name;
				if (entry.isDirectory()) {
					if (INDEX_SKIP_DIRS.has(entry.name)) continue;
					if (dir.depth + 1 <= INDEX_MAX_DEPTH && next.length < 5000) next.push({ rel, depth: dir.depth + 1 });
					else truncated = true;
				} else if (entry.isFile()) {
					files.push(rel);
					if (files.length > INDEX_LIMIT) return { files: files.slice(0, INDEX_LIMIT), truncated: true };
				}
			} } catch { truncated = true; }
		}
		queue = next;
	}
	return { files, truncated };
}

function ordinaryDiskFallback(error: unknown): boolean {
	const e = error as NodeJS.ErrnoException & { stderr?: string; killed?: boolean };
	return e.code === "ENOENT" || /not a git repository/i.test(String(e.stderr ?? ""));
}

interface IndexLimits { gitTimeoutMs?: number; gitMaxBytes?: number; fileLimit?: number }
function streamGitFiles(root: string, git: string, limits: IndexLimits): Promise<{ files: string[]; truncated: boolean }> {
	const fileLimit = Math.max(1, Math.min(INDEX_LIMIT, limits.fileLimit ?? INDEX_LIMIT));
	const maxBytes = Math.max(1, Math.min(4 * 1024 * 1024, limits.gitMaxBytes ?? 4 * 1024 * 1024));
	return new Promise((resolve, reject) => {
		const child = spawn(git, [...SAFE_GIT_ARGS, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, windowsHide: true, env: gitEnvironment(root), stdio: ["ignore", "pipe", "pipe"] });
		const decoder = new StringDecoder("utf8");
		const files = new Set<string>();
		let pending = "", stderr = "", bytes = 0, truncated = false, timedOut = false;
		const timer = setTimeout(() => { timedOut = true; child.kill(); }, Math.max(1, Math.min(15_000, limits.gitTimeoutMs ?? 15_000)));
		child.stdout!.on("data", (chunk: Buffer) => {
			if (truncated || timedOut) return;
			const room = maxBytes - bytes;
			const part = chunk.subarray(0, Math.max(0, room)); bytes += part.length;
			pending += decoder.write(part);
			let delimiter: number;
			while ((delimiter = pending.indexOf("\0")) >= 0) {
				const candidate = pending.slice(0, delimiter); pending = pending.slice(delimiter + 1);
				for (const value of parseLsFiles(candidate)) files.add(value);
				if (files.size >= fileLimit) { truncated = true; break; }
			}
			if (chunk.length > room || pending.length > 32 * 1024) truncated = true;
			if (truncated) child.kill();
		});
		child.stderr!.on("data", (chunk: Buffer) => { if (stderr.length < 8192) stderr += chunk.toString("utf8").slice(0, 8192 - stderr.length); });
		child.once("error", (error) => { clearTimeout(timer); reject(error); });
		child.once("close", (code) => {
			clearTimeout(timer);
			if (timedOut) return reject(Object.assign(new Error("git index timed out"), { code: "ETIMEDOUT" }));
			if (!truncated && code !== 0) return reject(Object.assign(new Error("git index unavailable"), { stderr }));
			if (pending || decoder.end()) truncated = true;
			resolve({ files: [...files], truncated });
		});
	});
}

/**
 * @ 引用的候选清单：git 可见的文件（含未被忽略的未跟踪文件）。
 * `git ls-files` 的路径相对当前目录，所以 cwd 就是工作区根，输出天然是工作区相对路径。
 */
export async function listWorkspaceIndex(cwdValue: unknown, limits?: IndexLimits): Promise<WorkspaceIndex> {
	const root = await resolveWorkspacePath(cwdValue);
	if (limits) return computeWorkspaceIndex(root, limits);
	const stamps = await Promise.all([root, path.join(root, ".git", "index"), path.join(root, ".gitignore")].map(async (target) => {
		const stat = await fs.stat(target).catch(() => null);
		return stat ? [stat.mtimeMs, stat.ctimeMs, stat.size, stat.ino].join(":") : "missing";
	}));
	const stamp = stamps.join("|");
	const cached = indexCache.get(root);
	if (cached && cached.stamp === stamp && Date.now() - cached.at < INDEX_CACHE_MS) return cached.promise;
	const promise = computeWorkspaceIndex(root);
	indexCache.delete(root);
	indexCache.set(root, { at: Date.now(), stamp, promise });
	while (indexCache.size > 16) indexCache.delete(indexCache.keys().next().value!);
	void promise.catch(() => { if (indexCache.get(root)?.promise === promise) indexCache.delete(root); });
	return promise;
}

async function computeWorkspaceIndex(root: string, limits: IndexLimits = {}): Promise<WorkspaceIndex> {
	try {
		const result = await streamGitFiles(root, await resolveGitBin(), limits);
		return { files: result.files.sort((a, b) => a.localeCompare(b)), source: "git", truncated: result.truncated };
	} catch (error) {
		const walked = await walkWorkspaceFiles(root);
		const ordinary = ordinaryDiskFallback(error);
		return { files: walked.files.sort((a, b) => a.localeCompare(b)), source: "disk", truncated: walked.truncated || !ordinary,
			...(!ordinary ? { warning: "Git 文件索引读取失败，已改用有界目录扫描；候选可能不完整，也可能包含 .gitignore 忽略的文件。" } : {}),
		};
	}
}


function toRel(root: string, target: string): string {
	const rel = path.relative(root, target).replace(/\\/g, "/");
	return rel === "" ? "." : rel;
}

/** `git check-ignore -z` 输出 → 相对路径数组 */
export function parseCheckIgnore(raw: string): string[] {
	return raw.split("\u0000").filter(Boolean).map((entry) => entry.split("\\").join("/"));
}

/**
 * 问 git 这个目录里哪些条目被 .gitignore 忽略（且未被跟踪）。
 * 用 check-ignore --stdin 一次问完整个目录：0 = 有被忽略的，1 = 一条都没有，128 = 不是仓库。
 * 条目多时命令行会超长，所以走 stdin 不走参数（单页最多 2000 条）。
 */
function checkIgnore(root: string, git: string, rels: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(git, [...SAFE_GIT_ARGS, "check-ignore", "-z", "--stdin"], {
			cwd: root,
			windowsHide: true,
			env: gitEnvironment(root),
		});
		let out = "";
		let err = "";
		let inputError: Error | undefined;
		// Pipe errors are asynchronous: try/catch around end() cannot handle EPIPE.
		child.stdin.on("error", (error) => { inputError = error; });
		const timer = setTimeout(() => { child.kill(); reject(new Error("git check-ignore timed out")); }, 10_000);
		child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString("utf8"); });
		child.stderr.on("data", (chunk: Buffer) => { err += chunk.toString("utf8"); });
		child.on("error", (error) => { clearTimeout(timer); reject(error); });
		child.on("close", (code) => {
			clearTimeout(timer);
			// Git can reject a non-repository before reading stdin; its failure explains
			// the resulting EPIPE. A successful exit still requires complete input.
			if (code !== 0 && code !== 1) reject(new Error(err.trim() || `git check-ignore exited with ${code}`));
			else if (inputError) reject(inputError);
			else if (code === 0) resolve(out);
			else resolve("");
		});
		try {
			child.stdin.end(`${rels.join("\u0000")}\u0000`);
		} catch (error) {
			inputError = error instanceof Error ? error : new Error(String(error));
		}
	});
}

/**
 * 这个目录里该从列表里去掉的名字:被 .gitignore 忽略的(node_modules/、.next、.claude 这类的构建产物与私有目录)。
 * 判据用 git 自己的规则，和快照树、@ 引用清单同一口径；不是仓库 / 没装 git / git 出错一律不过滤
 * （宁可多显示，也不能把用户的项目文件藏起来）。
 */
async function ignoredNames(root: string, dirRel: string, names: string[]): Promise<Set<string>> {
	if (!names.length) return new Set();
	try {
		const git = await resolveGitBin();
		const rels = names.map((name) => (dirRel ? `${dirRel}/${name}` : name));
		const raw = await checkIgnore(root, git, rels);
		// 输出是相对仓库根的路径：减掉当前目录前缀就回到名字集合
		const prefix = dirRel ? `${dirRel}/` : "";
		return new Set(parseCheckIgnore(raw).map((entry) => (prefix && entry.startsWith(prefix) ? entry.slice(prefix.length) : entry)));
	} catch {
		return new Set();
	}
}

export class FileLookupError extends BoundaryError {
	constructor(public code: "FILE_NOT_FOUND" | "IS_DIRECTORY", message: string) { super(message); }
}

function rethrowFileLookup(error: NodeJS.ErrnoException): never {
	if (error.code === "ENOENT" || error.code === "ENOTDIR") throw new FileLookupError("FILE_NOT_FOUND", "file not found");
	throw error;
}

/** Both tree entries and absolute paths from chat must resolve against the same workspace. */
async function existingWorkspacePath(root: string, requested: string, cwdValue: unknown): Promise<string> {
	let target = path.resolve(root, requested);
	if (path.isAbsolute(requested) && typeof cwdValue === "string" && isPathInside(cwdValue, requested)) {
		target = path.resolve(root, path.relative(cwdValue, requested));
	}
	if (!isPathInside(root, target)) {
		// An absolute reference can use another spelling of the workspace, e.g. /var instead of /private/var.
		const parent = path.isAbsolute(requested) ? await fs.realpath(path.dirname(target)).catch(() => null) : null;
		if (!parent || !isPathInside(root, parent)) throw new BoundaryError("path escapes the workspace", "OUT_OF_WORKSPACE");
		target = path.join(parent, path.basename(target));
	}
	const real = await fs.realpath(target).catch(rethrowFileLookup);
	if (!isPathInside(root, real)) throw new BoundaryError("path escapes the workspace", "OUT_OF_WORKSPACE");
	return real;
}

export async function listWorkspaceDir(cwdValue: unknown, relPath: unknown, offsetValue: unknown = 0): Promise<DirListing> {
	const root = await resolveWorkspacePath(cwdValue);
	const offset = offsetValue === null || offsetValue === "" ? 0 : Number(offsetValue);
	if (!Number.isSafeInteger(offset) || offset < 0) throw new BoundaryError("invalid directory offset");
	const real = await existingWorkspacePath(root, typeof relPath === "string" ? relPath : "", cwdValue);
	const stat = await fs.stat(real).catch(rethrowFileLookup);
	if (!stat.isDirectory()) throw new BoundaryError("not a directory");

	const raw = await fs.readdir(real, { withFileTypes: true });
	const entries: FileEntry[] = [];
	const special: typeof raw = [];
	for (const item of raw) {
		if (item.isDirectory()) {
			entries.push({ name: item.name, kind: "dir" });
			continue;
		}
		if (item.isFile()) {
			entries.push({ name: item.name, kind: "file" });
			continue;
		}
		special.push(item);
	}
	// Symlinks/junctions need stat before sorting because they may be directories.
	for (let i = 0; i < special.length; i += 64) {
		const inspected = await Promise.all(special.slice(i, i + 64).map(async (item) => {
			const info = await fs.stat(path.join(real, item.name)).catch(() => null);
			if (!info) return null;
			return { name: item.name, kind: info.isDirectory() ? "dir" : "file", size: info.isDirectory() ? undefined : info.size } as FileEntry;
		}));
		for (const entry of inspected) if (entry) entries.push(entry);
	}
	entries.sort((a, b) => {
		if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
		return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
	});
	// .gitignore 忽略的条目(node_modules/、.next/ 这些)不进列表:和快照树、@ 引用清单同一口径
	const relForIgnore = path.relative(root, real).replace(/\\/g, "/");
	// offset is a cursor into the sorted raw names. Only this slice is checked
	// against ignore rules; an all-ignored page can still have a next cursor.
	const candidates = entries.slice(offset, offset + MAX_ENTRIES);
	const ignored = await ignoredNames(root, relForIgnore, candidates.map((entry) => entry.name));
	const nextOffset = offset + MAX_ENTRIES < entries.length ? offset + MAX_ENTRIES : null;
	const page = ignored.size ? candidates.filter((entry) => !ignored.has(entry.name)) : candidates;
	for (let i = 0; i < page.length; i += 64) {
		await Promise.all(page.slice(i, i + 64).map(async (entry) => {
			if (entry.kind !== "file" || entry.size !== undefined) return;
			const info = await fs.stat(path.join(real, entry.name)).catch(() => null);
			if (info?.isFile()) entry.size = info.size;
		}));
	}
	return {
		dir: toRel(root, real),
		entries: page,
		nextOffset,
		truncated: nextOffset !== null,
	};
}

export interface FilePreview extends DecodedFilePreview {
	path: string;
	binary: boolean;
	truncated: boolean;
	content: string;
}

/** Pin the validated file handle, then verify its identity and canonical boundary. */
export async function openWorkspaceFile(cwdValue: unknown, relPath: unknown) {
	if (typeof relPath !== "string" || !relPath.trim() || relPath.length > 4096 || /[\u0000-\u001f\u007f]/.test(relPath)) throw new BoundaryError("invalid file path");
	const root = await resolveWorkspacePath(cwdValue);
	const real = await existingWorkspacePath(root, relPath, cwdValue);
	const stat = await fs.stat(real).catch(rethrowFileLookup);
	if (stat.isDirectory()) throw new FileLookupError("IS_DIRECTORY", "not a file");
	if (!stat.isFile()) throw new BoundaryError("not a file", "NOT_A_FILE");
	const handle = await fs.open(real, "r").catch(rethrowFileLookup);
	try {
		const opened = await handle.stat();
		const checked = await fs.realpath(real).catch(rethrowFileLookup);
		const current = await fs.stat(checked).catch(rethrowFileLookup);
		if (!isPathInside(root, checked)) throw new BoundaryError("path escapes the workspace", "OUT_OF_WORKSPACE");
		if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino
			|| opened.dev !== current.dev || opened.ino !== current.ino) throw new BoundaryError("file changed while opening");
		return { handle, size: opened.size, path: toRel(root, real), name: path.basename(real) };
	} catch (error) { await handle.close(); throw error; }
}

export async function readWorkspaceFile(cwdValue: unknown, relPath: unknown): Promise<FilePreview> {
	const { handle, size, path: relative } = await openWorkspaceFile(cwdValue, relPath);
	const buffer = Buffer.allocUnsafe(MAX_READ_BYTES + 1);
	let bytesRead = 0;
	try {
		while (bytesRead < buffer.length) {
			const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
			if (result.bytesRead === 0) break;
			bytesRead += result.bytesRead;
		}
	} finally {
		await handle.close();
	}
	const truncated = size > MAX_READ_BYTES || bytesRead > MAX_READ_BYTES;
	return { path: relative, truncated, ...decodeFilePreview(buffer.subarray(0, bytesRead), MAX_READ_BYTES, truncated) };
}

/** 上传附件的只读预览：只允许 <agentDir>/web-uploads 下的文件（输入框里还没发出去的附件也能看） */
export async function readUploadFile(uploadPath: unknown): Promise<FilePreview> {
	if (typeof uploadPath !== "string" || !uploadPath.trim() || uploadPath.length > 4096 || /[\u0000-\u001f\u007f]/.test(uploadPath)) throw new BoundaryError("invalid file path");
	if (!path.isAbsolute(uploadPath.trim())) throw new BoundaryError("upload path must be absolute");
	const uploadsRoot = await fs.realpath(path.join(getAgentDir(), "web-uploads")).catch(() => {
		throw new BoundaryError("uploads directory not found");
	});
	const target = path.resolve(uploadPath.trim());
	const real = await fs.realpath(target).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT" || error.code === "ENOTDIR") throw new BoundaryError("file not found");
		throw error;
	});
	if (!isPathInside(uploadsRoot, real)) throw new BoundaryError("upload path escapes the uploads directory");
	const stat = await fs.stat(real);
	if (!stat.isFile()) throw new BoundaryError("not a file");
	const handle = await fs.open(real, "r");
	try {
		const opened = await handle.stat();
		const checked = await fs.realpath(real);
		const current = await fs.stat(checked);
		if (!isPathInside(uploadsRoot, checked) || !opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino
			|| opened.dev !== current.dev || opened.ino !== current.ino) throw new BoundaryError("file changed while opening");
		const buffer = Buffer.allocUnsafe(MAX_READ_BYTES + 1);
		let bytesRead = 0;
		while (bytesRead < buffer.length) {
			const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
			if (result.bytesRead === 0) break;
			bytesRead += result.bytesRead;
		}
		const truncated = opened.size > MAX_READ_BYTES || bytesRead > MAX_READ_BYTES;
		return { path: target, truncated, ...decodeFilePreview(buffer.subarray(0, bytesRead), MAX_READ_BYTES, truncated) };
	} finally {
		await handle.close();
	}
}

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const IMAGE_TYPES: Record<string, string> = {
	".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
	".avif": "image/avif", ".bmp": "image/bmp", ".ico": "image/x-icon", ".svg": "image/svg+xml",
};

function matchesImageType(bytes: Buffer, mimeType: string): boolean {
	if (mimeType === "image/png") return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
	if (mimeType === "image/jpeg") return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
	if (mimeType === "image/gif") return /^GIF8[79]a$/.test(bytes.toString("ascii", 0, 6));
	if (mimeType === "image/webp") return bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
	if (mimeType === "image/bmp") return bytes.toString("ascii", 0, 2) === "BM";
	if (mimeType === "image/x-icon") return bytes.subarray(0, 4).equals(Buffer.from([0, 0, 1, 0]));
	if (mimeType === "image/avif") return bytes.toString("ascii", 4, 8) === "ftyp" && /(?:avif|avis)/.test(bytes.toString("ascii", 8, 64));
	if (mimeType === "image/svg+xml") {
		const svg = bytes.toString("utf8").replace(/^\uFEFF/, "").trimStart();
		// SVG is served with a sandbox CSP; do not accept XML entity declarations at all.
		return !/<!\s*(?:DOCTYPE|ENTITY)/i.test(svg) && /^(?:<\?xml\b[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg(?:\s|>)/i.test(svg);
	}
	return false;
}

/** Only bounded image data: lexical + realpath checks, ignore rules, MIME signatures and a read limit. */
export async function readWorkspaceImage(cwdValue: unknown, imagePath: unknown, sourcePath?: string | null): Promise<{ bytes: Buffer; mimeType: string }> {
	if (typeof imagePath !== "string" || !imagePath.trim() || imagePath.length > 4096 || /[\u0000-\u001f\u007f]/.test(imagePath)) throw new BoundaryError("invalid image path");
	const value = imagePath.trim();
	if (value.startsWith("//") || (!path.isAbsolute(value) && /^[a-z][a-z\d+.-]*:/i.test(value))) throw new BoundaryError("invalid image path");
	const mimeType = IMAGE_TYPES[path.extname(value).toLowerCase()];
	if (!mimeType) throw new BoundaryError("unsupported image type");
	const root = await resolveWorkspacePath(cwdValue);
	const requestedRoot = path.resolve(String(cwdValue).trim());
	const target = path.resolve(root, value);
	let real: string;
	if (sourcePath) {
		const { resolvePromptSourcePath } = await import("./prompt-sources");
		real = await resolvePromptSourcePath(target, root, sourcePath);
	} else {
		if (!isPathInside(root, target) && !isPathInside(requestedRoot, target)) throw new BoundaryError("image path escapes the workspace");
		real = await fs.realpath(target).catch(() => { throw new BoundaryError("image not found"); });
		if (!isPathInside(root, real)) throw new BoundaryError("image path escapes the workspace");
	}
	// Discovered skill attachments outside the workspace already passed their own stricter source boundary.
	if (isPathInside(root, real)) {
		const requestedRelative = isPathInside(root, target) ? toRel(root, target)
			: isPathInside(requestedRoot, target) ? toRel(requestedRoot, target) : toRel(root, real);
		const rels = [...new Set([requestedRelative, toRel(root, real)])];
		if (rels.some((rel) => rel.split("/").includes(".git"))) throw new BoundaryError("image is not a visible workspace file");
		try {
			const ignored = await checkIgnore(root, await resolveGitBin(), rels);
			if (parseCheckIgnore(ignored).length) throw new BoundaryError("image is ignored by the workspace");
		} catch (error) {
			if (error instanceof BoundaryError) throw error;
			if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !/not a git repository/i.test(String((error as Error).message))) throw error;
		}
	}
	const before = await fs.stat(real);
	const handle = await fs.open(real, "r");
	try {
		const stat = await handle.stat();
		const checked = await fs.realpath(real);
		const current = await fs.stat(checked);
		// Pin the same object authorized above. A parent replaced after the ignore
		// or skill-source checks must not redirect the image read outside its root.
		if (!samePath(checked, real) || stat.dev !== before.dev || stat.ino !== before.ino
			|| stat.dev !== current.dev || stat.ino !== current.ino) throw new BoundaryError("image changed while opening");
		if (!stat.isFile()) throw new BoundaryError("not an image file");
		if (stat.size > MAX_IMAGE_BYTES) throw new BoundaryError("image exceeds 20 MB");
		const bytes = Buffer.alloc(Math.min(stat.size + 1, MAX_IMAGE_BYTES + 1));
		let offset = 0;
		while (offset < bytes.length) {
			const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
			if (!bytesRead) break;
			offset += bytesRead;
		}
		if (offset > MAX_IMAGE_BYTES || offset > stat.size) throw new BoundaryError("image changed while reading");
		const content = bytes.subarray(0, offset);
		if (!matchesImageType(content, mimeType)) throw new BoundaryError("image content does not match its type");
		return { bytes: content, mimeType };
	} finally {
		await handle.close();
	}
}

// ---------- 拖拽上传（dsh attachment-local 语义：原样字节保存，模型经路径引用） ----------

/** 单文件上传上限：100 MB（与 ChatInput 本地校验一致） */
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const MAX_UPLOAD_BASE64_CHARS = Math.ceil(MAX_UPLOAD_BYTES / 3) * 4;

async function openUniqueUpload(name: string) {
	const safeName = sanitizeUploadName(name);
	const dir = path.join(getAgentDir(), "web-uploads");
	await fs.mkdir(dir, { recursive: true });
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	for (let i = 0; i < 32; i += 1) {
		const target = path.join(dir, `${stamp}_${i ? `${i}_` : ""}${safeName}`);
		try {
			return { handle: await fs.open(target, "wx"), target, safeName };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
	}
	throw new BoundaryError("upload filename collision limit exceeded");
}

/** 文件名净化：剥目录成分与控制字符，限长；空名给占位 */
function sanitizeUploadName(name: string): string {
	const base = name.replace(/[\\/\u0000-\u001f\u007f]/g, "_").trim();
	const trimmed = base.slice(0, 120);
	return trimmed || "upload.bin";
}

/**
 * 保存拖入的普通文件（非图片）：原样字节落盘到 ~/.pi/agent/web-uploads/，
 * 返回绝对路径供消息引用（agent 用 read/bash 等工具访问）。
 */
export async function saveUpload(name: unknown, dataBase64: unknown): Promise<{ path: string; name: string; size: number }> {
	if (typeof name !== "string" || typeof dataBase64 !== "string" || !dataBase64) throw new BoundaryError("missing upload payload");
	if (dataBase64.length > MAX_UPLOAD_BASE64_CHARS) throw new BoundaryError("file too large (max 100 MB)");
	const buffer = Buffer.from(dataBase64, "base64");
	if (buffer.length === 0) throw new BoundaryError("empty upload");
	if (buffer.length > MAX_UPLOAD_BYTES) throw new BoundaryError("file too large (max 100 MB)");

	const { handle, target, safeName } = await openUniqueUpload(name);
	try {
		await handle.writeFile(buffer);
	} catch (error) {
		await handle.close();
		await fs.unlink(target).catch(() => undefined);
		throw error;
	}
	await handle.close();
	scheduleUploadSweep();
	return { path: target, name: safeName, size: buffer.length };
}

/** 上传超过这么多天、且没有任何会话记录提到它，才会被清理 */
export const UPLOAD_RETENTION_DAYS = 30;
const UPLOAD_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
let lastUploadSweep = 0;

/** 上传成功后顺带在后台清理，每个进程每天最多一次 */
function scheduleUploadSweep(): void {
	const now = Date.now();
	if (now - lastUploadSweep < UPLOAD_SWEEP_INTERVAL_MS) return;
	lastUploadSweep = now;
	void sweepUploads(now).catch(() => undefined);
}

/** 清理预算：扫描字节数、会话文件数、总时长。任何一项用尽都视为“证据不足”，一个文件都不删。 */
export interface UploadSweepLimits {
	scanByteLimit?: number;
	sessionLimit?: number;
	timeoutMs?: number;
}

const DEFAULT_SCAN_BYTE_LIMIT = 256 * 1024 * 1024;
const DEFAULT_SESSION_LIMIT = 10_000;
const DEFAULT_SWEEP_TIMEOUT_MS = 5_000;
/** 候选上限：每个候选都要拿文件名去比每段文本，候选无限会让扫描退化成 O(文件数 × 文本量) */
const MAX_UPLOAD_CANDIDATES = 200;
/** 会话目录遍历上限（条目数、深度、目录数） */
const MAX_SESSION_ENTRIES = 20_000;
const MAX_SESSION_DEPTH = 32;
const MAX_SESSION_DIRS = 10_000;

interface UploadStamp {
	ino: number;
	size: number;
	mtimeMs: number;
}

type UploadFileStats = Awaited<ReturnType<typeof fs.stat>>;

function sameUploadStamp(a: { ino: number; size: number; mtimeMs: number }, b: { ino: number; size: number; mtimeMs: number }): boolean {
	return a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

function normalizeSweepLimits(limits: UploadSweepLimits): { scanByteLimit: number; sessionLimit: number; timeoutMs: number } | null {
	const scanByteLimit = limits.scanByteLimit ?? DEFAULT_SCAN_BYTE_LIMIT;
	const sessionLimit = limits.sessionLimit ?? DEFAULT_SESSION_LIMIT;
	const timeoutMs = limits.timeoutMs ?? DEFAULT_SWEEP_TIMEOUT_MS;
	if (!Number.isSafeInteger(scanByteLimit) || scanByteLimit <= 0 || !Number.isSafeInteger(sessionLimit) || sessionLimit <= 0 || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return null;
	return { scanByteLimit, sessionLimit, timeoutMs };
}

/** 引用检索的两种写法：原始文件名，以及 JSON 字符串里的转义写法（Windows 路径在 JSONL 里是双反斜杠） */
function uploadNeedles(name: string): string[] {
	return [name, JSON.stringify(name).slice(1, -1)];
}

function maxNeedleLength(candidates: Map<string, string[]>): number {
	let max = 0;
	for (const needles of candidates.values()) for (const needle of needles) max = Math.max(max, needle.length);
	return max;
}

/**
 * 扫描一个 JSONL 文件，把命中的候选文件名收进 found 并从 candidates 删除。
 * 返回 ok:false 表示这次读取不能作为“没被引用”的证据（打不开/超预算/读取期间文件被改）。
 */
async function scanSessionFileForUploads(
	file: string,
	candidates: Map<string, string[]>,
	overlap: number,
	state: { bytesRemaining: number },
	deadline: number,
	found: Set<string>,
): Promise<{ ok: false } | { ok: true; stamp: UploadStamp }> {
	let handle: Awaited<ReturnType<typeof fs.open>>;
	let metadata: UploadFileStats;
	try {
		handle = await fs.open(file, "r");
		try { metadata = await handle.stat(); } catch (error) { await handle.close(); throw error; }
	} catch {
		return { ok: false };
	}
	try {
		if (!metadata.isFile() || metadata.size > state.bytesRemaining) return { ok: false };
		const decoder = new StringDecoder("utf8");
		const buffer = Buffer.allocUnsafe(64 * 1024);
		let tail = "";
		for (;;) {
			if (performance.now() > deadline) return { ok: false };
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
			if (!bytesRead) break;
			state.bytesRemaining -= bytesRead;
			if (state.bytesRemaining < 0) return { ok: false };
			const text = tail + decoder.write(buffer.subarray(0, bytesRead));
			for (const [name, needles] of candidates) if (needles.some((needle) => text.includes(needle))) { found.add(name); candidates.delete(name); }
			if (!candidates.size) return { ok: true, stamp: metadata };
			tail = overlap > 0 ? text.slice(-overlap) : "";
		}
		const final = tail + decoder.end();
		for (const [name, needles] of candidates) if (needles.some((needle) => final.includes(needle))) { found.add(name); candidates.delete(name); }
		// 读取期间被追加/替换的文件不能用来证明“后面没人引用”
		if (!sameUploadStamp(metadata, await handle.stat())) return { ok: false };
		return { ok: true, stamp: metadata };
	} catch {
		return { ok: false };
	} finally {
		await handle.close().catch(() => undefined);
	}
}

/**
 * 会话引用扫描：把 sessions 目录下仍被任意 JSONL 引用的候选从 candidates 里删掉。
 * 会话目录读不全、超预算或扫描期间有变化一律返回 false —— 证据不足时一个都不能删。
 */
async function dropReferencedUploads(
	sessionsRoot: string,
	candidates: Map<string, string[]>,
	limits: { scanByteLimit: number; sessionLimit: number; timeoutMs: number },
	deadline: number,
): Promise<boolean> {
	if (!candidates.size) return true;
	const files: string[] = [];
	const stamps = new Map<string, UploadStamp>();
	const state = { bytesRemaining: limits.scanByteLimit };
	try {
		const enumerate = async (directory: string, depth: number): Promise<void> => {
			if (depth > MAX_SESSION_DEPTH || stamps.size > MAX_SESSION_DIRS || performance.now() > deadline) throw new Error("Upload reference inventory exceeded its limit");
			stamps.set(directory, await fs.stat(directory));
			for await (const entry of await fs.opendir(directory)) {
				if (performance.now() > deadline || stamps.size + files.length > MAX_SESSION_ENTRIES) throw new Error("Upload reference inventory exceeded its limit");
				if (entry.isSymbolicLink()) throw new Error("Upload reference inventory contains an unresolved link");
				const file = path.join(directory, entry.name);
				if (entry.isDirectory()) {
					if (entry.name.endsWith(".jsonl")) throw new Error("A session record is not a file");
					await enumerate(file, depth + 1);
				}
				else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
					files.push(file);
					if (files.length > limits.sessionLimit) throw new Error("Too many session files to establish orphaned uploads");
				}
			}
		};
		let rootMissing = false;
		try { await fs.stat(sessionsRoot); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false; rootMissing = true; }
		if (!rootMissing) await enumerate(sessionsRoot, 0);

		const overlap = Math.max(0, maxNeedleLength(candidates) - 1);
		for (const file of files) {
			const scanned = await scanSessionFileForUploads(file, candidates, overlap, state, deadline, new Set());
			if (!scanned.ok) return false;
			stamps.set(file, scanned.stamp);
			if (!candidates.size) return true;
		}
		// Concurrent appends, new sessions, and directory replacements invalidate absence evidence.
		for (const [file, stamp] of stamps) {
			if (performance.now() > deadline || !sameUploadStamp(stamp, await fs.stat(file))) return false;
		}
		if (rootMissing && await fs.stat(sessionsRoot).then(() => true, (error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
			return false;
		})) return false;
		return true;
	} catch {
		return false;
	}
}

/** 按“不真删”约定清理候选：先备份并记 INDEX（recoverableRemove 负责），确认删除前端文件没被改过。 */
async function removeUploadCandidates(dir: string, candidates: Map<string, string[]>, uploadStamps: Map<string, UploadStamp>): Promise<string[]> {
	const removed: string[] = [];
	for (const file of candidates.keys()) {
		try {
			const target = path.join(dir, file);
			const stamp = uploadStamps.get(file);
			if (!stamp || !sameUploadStamp(stamp, await fs.stat(target))) continue;
			await recoverableRemove(target, { reason: "清理无会话引用的上传附件，保留恢复副本" });
			removed.push(file);
		} catch { /* Keep the upload when backup or removal cannot be completed. */ }
	}
	return removed;
}

/**
 * 清理 web-uploads：消息里引用的是上传文件的绝对路径，所以只要还有会话 JSONL 提到文件名就保留
 * （会话被手动删除后，它的附件才变成孤儿）；没发出去的草稿留 30 天的余量。
 * 会话目录读不全就整次放弃，宁可不删也不误删。返回删掉的文件名。
 */
export async function sweepUploads(now = Date.now(), retentionDays = UPLOAD_RETENTION_DAYS, limits: UploadSweepLimits = {}): Promise<string[]> {
	if (!Number.isFinite(now) || !Number.isFinite(retentionDays) || retentionDays <= 0 || process.env.PI_WEB_UPLOAD_RETENTION === "0") return [];
	const normalized = normalizeSweepLimits(limits);
	if (!normalized) return [];
	const deadline = performance.now() + normalized.timeoutMs;
	const agentDir = getAgentDir();
	const dir = path.join(agentDir, "web-uploads");
	const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
	const candidates = new Map<string, string[]>();
	const uploadStamps = new Map<string, UploadStamp>();
	// Bound both the inventory and comparison work; incomplete evidence never permits a removal.
	try {
		let entries = 0;
		for await (const entry of await fs.opendir(dir)) {
			if (++entries > 10_000 || performance.now() > deadline) return [];
			if (!entry.isFile()) continue;
			const stat = await fs.stat(path.join(dir, entry.name));
			if (stat.mtimeMs > cutoff) continue;
			candidates.set(entry.name, uploadNeedles(entry.name));
			uploadStamps.set(entry.name, stat);
			if (candidates.size > MAX_UPLOAD_CANDIDATES) return [];
		}
	} catch { return []; }
	if (!candidates.size) return [];
	const sessionsRoot = path.join(agentDir, "sessions");
	if (!(await dropReferencedUploads(sessionsRoot, candidates, normalized, deadline))) return [];
	return removeUploadCandidates(dir, candidates, uploadStamps);
}

/**
 * 删除会话前调用：列出这个会话文件引用到的上传附件（web-uploads 下现存文件）。
 * 证据不足（目录读不全、超预算、文件读失败）返回空数组——宁可不清理，也不能误删别的会话还在用的附件。
 */
export async function listUploadsReferencedBySession(sessionPath: string, limits: UploadSweepLimits = {}): Promise<string[]> {
	const normalized = normalizeSweepLimits(limits);
	if (!normalized || typeof sessionPath !== "string" || !sessionPath) return [];
	const deadline = performance.now() + normalized.timeoutMs;
	const dir = path.join(getAgentDir(), "web-uploads");
	const candidates = new Map<string, string[]>();
	try {
		let entries = 0;
		for await (const entry of await fs.opendir(dir)) {
			if (++entries > 10_000 || performance.now() > deadline) return [];
			if (!entry.isFile()) continue;
			candidates.set(entry.name, uploadNeedles(entry.name));
			if (candidates.size > MAX_UPLOAD_CANDIDATES) return [];
		}
	} catch { return []; }
	if (!candidates.size) return [];
	const found = new Set<string>();
	const state = { bytesRemaining: normalized.scanByteLimit };
	const scanned = await scanSessionFileForUploads(sessionPath, candidates, Math.max(0, maxNeedleLength(candidates) - 1), state, deadline, found);
	return scanned.ok ? [...found] : [];
}

/**
 * 删除会话后调用：这些附件如果已经没有任何会话引用，就按仓库“不真删”约定清理
 * （recoverableRemove 先写恢复副本 + INDEX，再把原件移走/放进回收站）。
 * 返回实际清理的文件名；证据不足时返回空数组且不删任何文件。
 * 可用 PI_WEB_DELETE_ATTACHMENT_CLEANUP=0 单独关掉这项定向清理（与 sweepUploads 的留存开关互不影响）。
 */
export async function removeUnreferencedUploads(names: readonly string[], limits: UploadSweepLimits = {}): Promise<string[]> {
	if (process.env.PI_WEB_DELETE_ATTACHMENT_CLEANUP === "0") return [];
	const normalized = normalizeSweepLimits(limits);
	if (!normalized || !Array.isArray(names) || !names.length) return [];
	const agentDir = getAgentDir();
	const dir = path.join(agentDir, "web-uploads");
	const candidates = new Map<string, string[]>();
	const uploadStamps = new Map<string, UploadStamp>();
	for (const name of names) {
		if (typeof name !== "string" || !name || name !== path.basename(name)) continue;
		const stat = await fs.stat(path.join(dir, name)).catch(() => null);
		if (!stat?.isFile()) continue;
		candidates.set(name, uploadNeedles(name));
		uploadStamps.set(name, stat);
	}
	if (!candidates.size) return [];
	const deadline = performance.now() + normalized.timeoutMs;
	if (!(await dropReferencedUploads(path.join(agentDir, "sessions"), candidates, normalized, deadline))) return [];
	return removeUploadCandidates(dir, candidates, uploadStamps);
}

export function parseUploadLength(value: string | null): number {
	if (value === null || !/^\d+$/.test(value)) throw new BoundaryError("missing or invalid upload size");
	const size = Number(value);
	if (!Number.isSafeInteger(size) || size <= 0) throw new BoundaryError("empty or invalid upload size");
	if (size > MAX_UPLOAD_BYTES) throw new BoundaryError("file too large (max 100 MB)");
	return size;
}

export async function saveUploadStream(name: unknown, stream: ReadableStream<Uint8Array> | null, expectedSize?: number): Promise<{ path: string; name: string; size: number }> {
	if (typeof name !== "string" || !name.trim() || !stream) throw new BoundaryError("missing upload payload");
	if (expectedSize !== undefined) parseUploadLength(String(expectedSize));
	const { handle, target, safeName } = await openUniqueUpload(name);
	const reader = stream.getReader();
	let size = 0;
	let complete = false;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > MAX_UPLOAD_BYTES) throw new BoundaryError("file too large (max 100 MB)");
			if (expectedSize !== undefined && size > expectedSize) throw new BoundaryError("upload size does not match the declared length");
			let offset = 0;
			while (offset < value.byteLength) {
				const { bytesWritten } = await handle.write(value, offset, value.byteLength - offset, null);
				if (bytesWritten === 0) throw new Error("upload write made no progress");
				offset += bytesWritten;
			}
		}
		if (size === 0) throw new BoundaryError("empty upload");
		if (expectedSize !== undefined && size !== expectedSize) throw new BoundaryError("incomplete upload: size does not match the declared length");
		complete = true;
		scheduleUploadSweep();
		return { path: target, name: safeName, size };
	} finally {
		await reader.cancel().catch(() => undefined);
		reader.releaseLock();
		await handle.close();
		if (!complete) await fs.unlink(target).catch(() => undefined);
	}
}

/**
 * 在本机编辑器里打开工作区文件（服务本来就跑在本机）。
 * 默认 `code`（VS Code），可用 PI_WEB_EDITOR 覆盖（cursor / windsurf / subl / notepad …）。
 * VS Code 系列支持 `-g 路径:行号`，其他编辑器只传路径。
 */
export async function openInEditor(cwdValue: unknown, relOrAbs: unknown, line?: unknown): Promise<{ editor: string; target: string }> {
	if (typeof relOrAbs !== "string" || !relOrAbs.trim()) throw new BoundaryError("missing file path");
	const root = await resolveWorkspacePath(cwdValue);
	const target = path.isAbsolute(relOrAbs) ? path.resolve(relOrAbs) : path.resolve(root, relOrAbs.trim().replace(/^[/\\]+/, ""));
	if (!isPathInside(root, target)) throw new BoundaryError("path escapes the workspace");
	const real = await fs.realpath(target).catch(() => {
		throw new BoundaryError("file not found");
	});
	if (!isPathInside(root, real)) throw new BoundaryError("path escapes the workspace");

	const editor = (process.env.PI_WEB_EDITOR || "code").trim();
	const gotoCapable = /\b(code|codium|cursor|windsurf|trae)\b/i.test(editor);
	const lineNo = typeof line === "number" && Number.isFinite(line) && line > 0 ? Math.floor(line) : undefined;
	const args = gotoCapable ? ["-g", lineNo ? `${real}:${lineNo}` : real] : [real];
	if (process.platform === "win32" && !isSafeWindowsEditorArgument(`${editor}${real}`)) {
		throw new BoundaryError("file or editor path contains characters unsafe for cmd.exe");
	}

	await new Promise<void>((resolve, reject) => {
		// Windows 下 code 是 code.cmd，必须经 cmd.exe 启动；Node 会给带空格的参数自动加引号
		const child = process.platform === "win32"
			? spawn(process.env.ComSpec || "cmd.exe", ["/d", "/c", editor, ...args], { stdio: "ignore", windowsHide: true, env: childProcessEnv() })
			: spawn(editor, args, { stdio: "ignore", detached: true, env: childProcessEnv() });
		const timer = setTimeout(() => {
			// 编辑器进程长期不退出（首次启动 GUI）也视为成功
			resolve();
		}, 4000);
		child.on("error", (error) => {
			clearTimeout(timer);
			reject(new Error(`无法启动编辑器 "${editor}"：${error.message}`));
		});
		child.on("exit", (code) => {
			clearTimeout(timer);
			if (code === 0 || code === null) resolve();
			else reject(new Error(`编辑器 "${editor}" 退出码 ${code}；请确认它在 PATH 中，或用 PI_WEB_EDITOR 指定`));
		});
		if (process.platform !== "win32") child.unref();
	});
	return { editor, target: real };
}

export function isSafeWindowsEditorArgument(value: string): boolean {
	return !/[&|^<>()%!"\x00-\x1f]/.test(value);
}
