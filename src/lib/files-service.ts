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
	truncated: boolean;
}

/** 文本预览上限：256 KB——详情栏预览用，不是文件编辑器 */
const MAX_READ_BYTES = 256 * 1024;
/** 单目录条目上限：超大目录（node_modules 等）只给前 2000 项 */
const MAX_ENTRIES = 2000;

function toRel(root: string, target: string): string {
	const rel = path.relative(root, target).replace(/\\/g, "/");
	return rel === "" ? "." : rel;
}

export async function listWorkspaceDir(cwdValue: unknown, relPath: unknown): Promise<DirListing> {
	const root = await resolveWorkspacePath(cwdValue);
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
	// 优先用 Dirent 的类型，只对符号链接/连接点 stat 兜底；大目录（node_modules）不再逐项 stat
	const pending: Array<Promise<void>> = [];
	for (const item of raw) {
		if (item.isDirectory()) {
			entries.push({ name: item.name, kind: "dir" });
			continue;
		}
		if (item.isFile()) {
			pending.push(
				fs.stat(path.join(real, item.name)).then(
					(info) => {
						entries.push({ name: item.name, kind: "file", size: info.size });
					},
					() => undefined,
				),
			);
			continue;
		}
		pending.push(
			fs.stat(path.join(real, item.name)).then(
				(info) => {
					entries.push({ name: item.name, kind: info.isDirectory() ? "dir" : "file", size: info.isDirectory() ? undefined : info.size });
				},
				() => undefined,
			),
		);
	}
	await Promise.all(pending);
	entries.sort((a, b) => {
		if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
		return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
	});
	const truncated = entries.length > MAX_ENTRIES;
	return {
		dir: toRel(root, real),
		entries: truncated ? entries.slice(0, MAX_ENTRIES) : entries,
		truncated,
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

	const buffer = await fs.readFile(real);
	// 含 NUL 字节按二进制处理，不做文本预览
	if (buffer.includes(0)) {
		return { path: toRel(root, real), binary: true, truncated: false, content: "" };
	}
	const truncated = stat.size > MAX_READ_BYTES;
	return {
		path: toRel(root, real),
		binary: false,
		truncated,
		content: buffer.subarray(0, MAX_READ_BYTES).toString("utf8"),
	}
}

// ---------- 拖拽上传（dsh attachment-local 语义：原样字节保存，模型经路径引用） ----------

/** 单文件上传上限：50 MB（压缩包/日志等走这条链路；图片走既有 image 附件） */
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

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
	const buffer = Buffer.from(dataBase64, "base64");
	if (buffer.length === 0) throw new BoundaryError("empty upload");
	if (buffer.length > MAX_UPLOAD_BYTES) throw new BoundaryError("file too large (max 100 MB)");

	const safeName = sanitizeUploadName(name);
	const dir = path.join(getAgentDir(), "web-uploads");
	await fs.mkdir(dir, { recursive: true });
	// 防碰撞：时间戳前缀 + 同名自增
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	let target = path.join(dir, `${stamp}_${safeName}`);
	for (let i = 1; ; i += 1) {
		try {
			const handle = await fs.open(target, "wx");
			await handle.writeFile(buffer);
			await handle.close();
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") {
				target = path.join(dir, `${stamp}_${i}_${safeName}`);
				continue;
			}
			throw error;
		}
	}
	return { path: target, name: safeName, size: buffer.length };
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
	const gotoCapable = /(code|codium|cursor|windsurf|trae)/i.test(editor);
	const lineNo = typeof line === "number" && Number.isFinite(line) && line > 0 ? Math.floor(line) : undefined;
	const args = gotoCapable ? ["-g", lineNo ? `${real}:${lineNo}` : real] : [real];

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
