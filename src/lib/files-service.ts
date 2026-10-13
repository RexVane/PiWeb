/**
 * files-service：会话工作区的文件浏览（详情栏「文件」面板）。
 * 安全边界：目标路径必须落在工作区根内（realpath 双重校验，防符号链接逃逸）。
 */
import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { BoundaryError, isPathInside, resolveWorkspacePath } from "./path-security";
import { getAgentDir } from "./pi";
import { resolveGitBin } from "./growth-service";
import { utf8Prefix } from "./text-sanitize";

const exec = promisify(execFile);

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

export interface WorkspaceIndex {
	/** 工作区根下的相对路径（"/" 分隔）。只给文件：文件夹由前端从文件路径推导 */
	files: string[];
	/** git = `git ls-files`（尊重 .gitignore）；disk = 不是仓库时的目录遍历退路 */
	source: "git" | "disk";
	/** 候选被上限截断：匹配结果可能不全，界面要说明 */
	truncated: boolean;
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
	let queue: Array<{ rel: string; depth: number }> = [{ rel: "", depth: 0 }];
	while (queue.length) {
		const next: typeof queue = [];
		for (const dir of queue) {
			const entries = await fs.readdir(path.join(root, dir.rel), { withFileTypes: true }).catch(() => []);
			for (const entry of entries) {
				const rel = dir.rel ? `${dir.rel}/${entry.name}` : entry.name;
				if (entry.isDirectory()) {
					if (dir.depth + 1 <= INDEX_MAX_DEPTH && !INDEX_SKIP_DIRS.has(entry.name)) next.push({ rel, depth: dir.depth + 1 });
				} else if (entry.isFile()) {
					files.push(rel);
					if (files.length > INDEX_LIMIT) return { files: files.slice(0, INDEX_LIMIT), truncated: true };
				}
			}
		}
		queue = next;
	}
	return { files, truncated: false };
}

/**
 * git 失败时只有「不是仓库」「没装 git」两种该退回遍历——界面会把 disk 来源解释成这两种情况。
 * 其它失败（safe.directory 拒绝、索引损坏、超时）照实报错：退回遍历会把 .gitignore 掉的文件混进候选，还给出错误的解释。
 */
function gitIndexFailure(error: unknown): "fallback" | Error {
	const e = error as NodeJS.ErrnoException & { stderr?: string; killed?: boolean };
	if (e.code === "ENOENT") return "fallback";
	const stderr = String(e.stderr ?? "");
	if (/not a git repository/i.test(stderr)) return "fallback";
	if (e.killed) return new Error("git ls-files timed out");
	const fatal = stderr.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
	return new Error(`git ls-files failed: ${fatal.find((line) => line.startsWith("fatal:")) ?? fatal[0] ?? e.message}`);
}

/**
 * @ 引用的候选清单：git 可见的文件（含未被忽略的未跟踪文件）。
 * `git ls-files` 的路径相对当前目录，所以 cwd 就是工作区根，输出天然是工作区相对路径。
 */
export async function listWorkspaceIndex(cwdValue: unknown): Promise<WorkspaceIndex> {
	const root = await resolveWorkspacePath(cwdValue);
	const git = await resolveGitBin();
	try {
		const { stdout } = await exec(git, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
			cwd: root,
			timeout: 15_000,
			maxBuffer: 64 * 1024 * 1024,
			windowsHide: true,
			// LC_ALL=C：报错固定为英文，「不是仓库」才认得出来（中文界面的 git 会翻译这句）；-z 输出的路径不受影响
			env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
		});
		const files = parseLsFiles(stdout).sort((a, b) => a.localeCompare(b));
		return { files: files.slice(0, INDEX_LIMIT), source: "git", truncated: files.length > INDEX_LIMIT };
	} catch (error) {
		const failure = gitIndexFailure(error);
		if (failure !== "fallback") throw failure;
		const walked = await walkWorkspaceFiles(root);
		return { files: walked.files.sort((a, b) => a.localeCompare(b)), source: "disk", truncated: walked.truncated };
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
		const child = spawn(git, ["check-ignore", "-z", "--stdin"], {
			cwd: root,
			windowsHide: true,
			env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
		});
		let out = "";
		let err = "";
		const timer = setTimeout(() => { child.kill(); reject(new Error("git check-ignore timed out")); }, 10_000);
		child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString("utf8"); });
		child.stderr.on("data", (chunk: Buffer) => { err += chunk.toString("utf8"); });
		child.on("error", (error) => { clearTimeout(timer); reject(error); });
		child.on("close", (code) => {
			clearTimeout(timer);
			if (code === 0) resolve(out);
			else if (code === 1) resolve("");
			else reject(new Error(err.trim() || `git check-ignore exited with ${code}`));
		});
		try {
			child.stdin.end(`${rels.join("\u0000")}\u0000`);
		} catch {
			// git 提前退出时 stdin 会 EPIPE；close 事件会给出真正的结论
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

export async function listWorkspaceDir(cwdValue: unknown, relPath: unknown, offsetValue: unknown = 0): Promise<DirListing> {
	const root = await resolveWorkspacePath(cwdValue);
	const offset = offsetValue === null || offsetValue === "" ? 0 : Number(offsetValue);
	if (!Number.isSafeInteger(offset) || offset < 0) throw new BoundaryError("invalid directory offset");
	const rel = typeof relPath === "string" && relPath.trim() ? relPath.trim().replace(/^[/\\]+/, "") : "";
	const target = path.resolve(root, rel);
	if (!isPathInside(root, target)) throw new BoundaryError("path escapes the workspace");
	const real = await fs.realpath(target).catch(() => {
		throw new BoundaryError("directory not found");
	});
	if (!isPathInside(root, real)) throw new BoundaryError("path escapes the workspace");
	const stat = await fs.stat(real);
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
	const ignored = await ignoredNames(root, relForIgnore, entries.map((entry) => entry.name));
	const visible = ignored.size ? entries.filter((entry) => !ignored.has(entry.name)) : entries;
	const nextOffset = offset + MAX_ENTRIES < visible.length ? offset + MAX_ENTRIES : null;
	const page = visible.slice(offset, offset + MAX_ENTRIES);
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

export interface FilePreview {
	path: string;
	binary: boolean;
	truncated: boolean;
	content: string;
}

export async function readWorkspaceFile(cwdValue: unknown, relPath: unknown): Promise<FilePreview> {
	if (typeof relPath !== "string" || !relPath.trim()) throw new BoundaryError("missing file path");
	const root = await resolveWorkspacePath(cwdValue);
	const target = path.resolve(root, relPath.trim().replace(/^[/\\]+/, ""));
	if (!isPathInside(root, target)) throw new BoundaryError("path escapes the workspace");
	const real = await fs.realpath(target).catch(() => {
		throw new BoundaryError("file not found");
	});
	if (!isPathInside(root, real)) throw new BoundaryError("path escapes the workspace");
	const stat = await fs.stat(real);
	if (!stat.isFile()) throw new BoundaryError("not a file");

	const handle = await fs.open(real, "r");
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
	const preview = utf8Prefix(buffer.subarray(0, bytesRead), MAX_READ_BYTES);
	// 只检查预览范围，绝不为识别二进制而加载整个大文件
	if (preview.includes(0)) {
		return { path: toRel(root, real), binary: true, truncated: false, content: "" };
	}
	const truncated = stat.size > MAX_READ_BYTES || bytesRead > MAX_READ_BYTES;
	return {
		path: toRel(root, real),
		binary: false,
		truncated,
		content: preview.toString("utf8"),
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

/**
 * 清理 web-uploads：消息里引用的是上传文件的绝对路径，所以只要还有会话 JSONL 提到文件名就保留
 * （会话被删、或归档过期删除后，它的附件才变成孤儿）；没发出去的草稿留 30 天的余量。
 * 会话目录读不全就整次放弃，宁可不删也不误删。返回删掉的文件名。
 */
export async function sweepUploads(now = Date.now(), retentionDays = UPLOAD_RETENTION_DAYS): Promise<string[]> {
	const agentDir = getAgentDir();
	const dir = path.join(agentDir, "web-uploads");
	const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
	const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
	// 文件名 → 在 JSONL 里可能出现的写法（原样 / JSON 转义后）
	const candidates = new Map<string, string[]>();
	for (const entry of entries) {
		if (!entry.isFile()) continue;
		const stat = await fs.stat(path.join(dir, entry.name)).catch(() => null);
		if (!stat || stat.mtimeMs > cutoff) continue;
		candidates.set(entry.name, [entry.name, JSON.stringify(entry.name).slice(1, -1)]);
	}
	if (!candidates.size) return [];
	const sessionsRoot = path.join(agentDir, "sessions");
	let sessionFiles: string[];
	try {
		sessionFiles = (await fs.readdir(sessionsRoot, { recursive: true })).filter((name) => name.endsWith(".jsonl"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") return [];
		sessionFiles = [];
	}
	for (const name of sessionFiles) {
		let text: string;
		try {
			text = await fs.readFile(path.join(sessionsRoot, name), "utf8");
		} catch {
			return [];
		}
		for (const [file, needles] of candidates) if (needles.some((needle) => text.includes(needle))) candidates.delete(file);
		if (!candidates.size) return [];
	}
	const removed: string[] = [];
	for (const file of candidates.keys()) {
		await fs.unlink(path.join(dir, file)).then(() => removed.push(file), () => undefined);
	}
	return removed;
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
			? spawn(process.env.ComSpec || "cmd.exe", ["/d", "/c", editor, ...args], { stdio: "ignore", windowsHide: true })
			: spawn(editor, args, { stdio: "ignore", detached: true });
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
