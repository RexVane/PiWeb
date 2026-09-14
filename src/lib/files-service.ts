/**
 * files-service：会话工作区的文件浏览（详情栏「文件」面板）。
 * 安全边界：目标路径必须落在工作区根内（realpath 双重校验，防符号链接逃逸）。
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { BoundaryError, isPathInside, resolveWorkspacePath } from "./path-security";
import { getAgentDir } from "./pi";

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

function toRel(root: string, target: string): string {
	const rel = path.relative(root, target).replace(/\\/g, "/");
	return rel === "" ? "." : rel;
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
	const nextOffset = offset + MAX_ENTRIES < entries.length ? offset + MAX_ENTRIES : null;
	const page = entries.slice(offset, offset + MAX_ENTRIES);
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
	const preview = buffer.subarray(0, Math.min(bytesRead, MAX_READ_BYTES));
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
	return { path: target, name: safeName, size: buffer.length };
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
