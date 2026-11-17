/**
 * git-service：会话工作区的 Git 状态、差异与工作台写操作（暂存 / 按块暂存 / 提交 / 推送 / 拉取）。
 * 所有 git 命令以仓库根为 cwd 运行，因为 porcelain 输出的路径都相对仓库根。
 */
import { execFile, spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { parseNumstat, resolveGitBin } from "./growth-service";
import { decodeFilePreview, type DecodedFilePreview } from "./file-preview";
import { BoundaryError, isPathInside, resolveWorkspacePath } from "./path-security";
import { gitEnv } from "./child-process-env";
import { buildSingleHunkPatch, parseRawPatchBlocks, type RawHunkAnchor } from "./git-hunk";
import { utf8Prefix } from "./text-sanitize";

const exec = promisify(execFile);

export class GitActionError extends Error {
	status: number;
	code?: string;
	constructor(message: string, status = 400, code?: string) {
		super(message);
		this.name = "GitActionError";
		this.status = status;
		this.code = code;
	}
}

export interface GitFileEntry {
	path: string;
	/** 重命名 / 复制时的原路径 */
	from?: string;
	/** 暂存区状态字母（" " 表示无） */
	indexStatus: string;
	/** 工作区状态字母（" " 表示无） */
	workStatus: string;
	kind: "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflict";
}

export interface GitCommit {
	hash: string;
	subject: string;
	author: string;
	/** git 的相对时间（"2 hours ago"） */
	relative: string;
}

export interface GitCommitFile {
	path: string;
	from?: string;
	status: "A" | "M" | "D" | "R" | "C";
	add: number;
	del: number;
	binary: boolean;
}

export interface GitInfo {
	/** 机器上找不到 git 命令 */
	available: boolean;
	isRepo: boolean;
	/** 仓库根（用于把面板里的相对路径映射回文件面板） */
	root: string | null;
	branch: string | null;
	upstream: string | null;
	ahead: number;
	behind: number;
	detached: boolean;
	files: GitFileEntry[];
	/** 状态读取失败时文件变更未知；不能把空 files 解读为工作区干净。 */
	statusError?: string;
	commits: GitCommit[];
}

const EMPTY: GitInfo = {
	available: true,
	isRepo: false,
	root: null,
	branch: null,
	upstream: null,
	ahead: 0,
	behind: 0,
	detached: false,
	files: [],
	commits: [],
};

/** 摘要 / 抽屉单次差异输出上限 */
const MAX_DIFF_BYTES = 400 * 1024;
/** 全文件并排查看（FileViewer）的单文件差异输出上限（与 growth-service 对齐） */
const MAX_FULL_DIFF_BYTES = 4 * 1024 * 1024;
/** 全文回退预览上限 */
const MAX_CONTENT_BYTES = 256 * 1024;

const SAFE_GIT_ARGS = ["-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "-c", "core.hooksPath=", "-c", "i18n.logOutputEncoding=UTF-8", "-c", "core.pager=cat", "-c", "core.quotePath=false"];
/** 提交与远程同步允许触发用户配置 hooks（如 pre-commit / pre-push） */
const USER_HOOK_GIT_ARGS = ["-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "-c", "i18n.logOutputEncoding=UTF-8", "-c", "core.pager=cat", "-c", "core.quotePath=false"];

/** 进程内按仓库根串行化写操作，避免连续点击快速暂存/取消暂存撞上 .git/index.lock */
const repoLocks = new Map<string, Promise<unknown>>();

function repoLockKey(root: string): string {
	let canonical = root;
	try { canonical = realpathSync.native(root); } catch { canonical = path.resolve(root); }
	return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

async function withRepoLock<T>(root: string, task: () => Promise<T>): Promise<T> {
	const key = repoLockKey(root);
	const prior = repoLocks.get(key) ?? Promise.resolve();
	const next = prior.catch(() => undefined).then(task);
	repoLocks.set(key, next);
	try {
		return await next;
	} finally {
		if (repoLocks.get(key) === next) repoLocks.delete(key);
	}
}

/**
 * A6/G3：git 子进程不再整体继承 `process.env`。`gitEnv` 默认剥掉名字像凭据的变量
 * （启动令牌/provider key/代理口令）并移除继承的 GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE
 * 等会话注入变量；PATH/HOME/LC_ALL 及 git 正常联网所需变量保留，`extra` 补 git 必需值。
 */
function gitEnvironment(cwd: string, readOnly = true): NodeJS.ProcessEnv {
	return gitEnv({
		...(readOnly ? { GIT_OPTIONAL_LOCKS: "0" } : {}),
		GIT_TERMINAL_PROMPT: "0",
		GIT_CEILING_DIRECTORIES: path.dirname(cwd),
		LC_ALL: "C",
	}) as NodeJS.ProcessEnv;
}

/** 与生长记录共用解析出的 git（macOS 从 GUI / launchd 启动时 PATH 里常常没有 Homebrew 的 git） */
async function runGit(cwd: string, args: string[], maxBuffer = 4 * 1024 * 1024): Promise<string> {
	return exec(await resolveGitBin(), [...SAFE_GIT_ARGS, ...args], { cwd, timeout: 15_000, maxBuffer, windowsHide: true, env: gitEnvironment(cwd, true) }).then((r) => r.stdout);
}

/** 运行写操作或联网 git 命令（可选 stdin、支持 hooks、自定义超时） */
async function runGitCommand(
	cwd: string,
	args: string[],
	opts: { input?: string; allowHooks?: boolean; timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
	const git = await resolveGitBin();
	const prefix = opts.allowHooks ? USER_HOOK_GIT_ARGS : SAFE_GIT_ARGS;
	const timeoutMs = opts.timeoutMs ?? 15_000;
	return new Promise((resolve, reject) => {
		const child = spawn(git, [...prefix, ...args], {
			cwd,
			windowsHide: true,
			env: gitEnvironment(cwd, false),
			stdio: [opts.input !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
		});
		const outChunks: Buffer[] = [];
		const errChunks: Buffer[] = [];
		let settled = false;
		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (error) reject(error);
			else resolve({ stdout: Buffer.concat(outChunks).toString("utf8"), stderr: Buffer.concat(errChunks).toString("utf8") });
		};
		const timer = setTimeout(() => {
			child.kill();
			finish(new GitActionError(`git ${args[0]} 超时`, 504));
		}, timeoutMs);
		child.stdout?.on("data", (chunk: Buffer) => outChunks.push(chunk));
		child.stderr?.on("data", (chunk: Buffer) => errChunks.push(chunk));
		child.on("error", (err) => finish(err));
		child.on("close", (code) => {
			if (code === 0) finish();
			else {
				const err = Buffer.concat(errChunks).toString("utf8").trim();
				const out = Buffer.concat(outChunks).toString("utf8").trim();
				finish(new Error(err || out || `git ${args[0]} exited with ${code}`));
			}
		});
		if (opts.input !== undefined && child.stdin) {
			child.stdin.on("error", () => undefined);
			child.stdin.end(opts.input, "utf8");
		}
	});
}

/** Drain the whole command while retaining only a bounded preview. Large diffs cannot fill execFile's buffer. */
async function runGitPatch(cwd: string, args: string[], limitBytes = MAX_DIFF_BYTES): Promise<{ patch: string; truncated: boolean }> {
	const git = await resolveGitBin();
	return new Promise((resolve, reject) => {
		const child = spawn(git, [...SAFE_GIT_ARGS, ...args], { cwd, windowsHide: true, env: gitEnvironment(cwd, true), stdio: ["ignore", "pipe", "pipe"] });
		const chunks: Buffer[] = [];
		let retained = 0, total = 0, stderr = "", settled = false;
		const finish = (error?: Error) => {
			if (settled) return; settled = true; clearTimeout(timer);
			if (error) reject(error);
			else resolve({ patch: utf8Prefix(Buffer.concat(chunks, retained), limitBytes).toString("utf8"), truncated: total > limitBytes });
		};
		const timer = setTimeout(() => { child.kill(); finish(new Error("git diff timed out")); }, 15_000);
		child.stdout.on("data", (chunk: Buffer) => {
			total += chunk.length;
			if (retained < limitBytes + 4) { const part = chunk.subarray(0, limitBytes + 4 - retained); chunks.push(part); retained += part.length; }
		});
		child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-8192); });
		child.on("error", (error) => finish(error));
		child.on("close", (code) => finish(code === 0 ? undefined : new Error(stderr.trim() || "git diff exited with " + code)));
	});
}

/** 读取未截断原始字节块用于服务端切块暂存，带合理上限避免意外撑爆内存 */
async function runGitRawStdout(cwd: string, args: string[], maxBytes = 8 * 1024 * 1024): Promise<Buffer> {
	const git = await resolveGitBin();
	return new Promise((resolve, reject) => {
		const child = spawn(git, [...SAFE_GIT_ARGS, ...args], { cwd, windowsHide: true, env: gitEnvironment(cwd, false), stdio: ["ignore", "pipe", "pipe"] });
		const chunks: Buffer[] = [];
		let total = 0, stderr = "", settled = false;
		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (error) reject(error);
			else resolve(Buffer.concat(chunks, total));
		};
		const timer = setTimeout(() => { child.kill(); finish(new Error("git diff timed out")); }, 15_000);
		child.stdout.on("data", (chunk: Buffer) => {
			total += chunk.length;
			if (total > maxBytes) {
				child.kill();
				finish(new GitActionError("文件差异过大，无法按块暂存，请直接暂存整文件", 413));
				return;
			}
			chunks.push(chunk);
		});
		child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-8192); });
		child.on("error", (err) => finish(err));
		child.on("close", (code) => finish(code === 0 ? undefined : new Error(stderr.trim() || `git exited with ${code}`)));
	});
}

function kindOf(x: string, y: string): GitFileEntry["kind"] {
	if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) return "conflict";
	const letter = x !== "." ? x : y;
	if (letter === "A") return "added";
	if (letter === "D") return "deleted";
	if (letter === "R" || letter === "C") return "renamed";
	return "modified";
}

/** 解析仓库根（GitHub 身份解析也要用，所以导出） */
export async function repoRoot(cwd: string): Promise<{ available: boolean; root: string | null }> {
	try {
		const out = (await runGit(cwd, ["rev-parse", "--show-toplevel"])).trim();
		const root = out ? path.resolve(out) : null;
		return { available: true, root: root && isPathInside(cwd, root) ? root : null };
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return { available: false, root: null };
		const stderr = String((error as { stderr?: unknown }).stderr ?? "");
		if (/not a git repository/i.test(stderr)) return { available: true, root: null };
		throw new Error(stderr.trim() || (error instanceof Error ? error.message : String(error)));
	}
}

export async function gitInfo(cwdValue: unknown): Promise<GitInfo> {
	const cwd = await resolveWorkspacePath(cwdValue);
	const { available, root } = await repoRoot(cwd);
	if (!available) return { ...EMPTY, available: false };
	if (!root) return EMPTY;

	let branch: string | null = null;
	let upstream: string | null = null;
	let ahead = 0;
	let behind = 0;
	let detached = false;
	let statusError: string | undefined;
	const files: GitFileEntry[] = [];
	try {
		// porcelain v2 是结构化输出，不依赖 "No branch" 这类措辞；-z 让含空格/非 ASCII 的路径也稳定
		const status = await runGit(root, ["status", "--porcelain=v2", "--branch", "--untracked-files=all", "-z"]);
		const records = status.split("\0");
		for (let i = 0; i < records.length; i += 1) {
			const line = records[i];
			if (!line) continue;
			if (line.startsWith("# branch.head ")) {
				const head = line.slice("# branch.head ".length);
				if (head === "(detached)") detached = true;
				else branch = head;
				continue;
			}
			if (line.startsWith("# branch.upstream ")) {
				upstream = line.slice("# branch.upstream ".length);
				continue;
			}
			if (line.startsWith("# branch.ab ")) {
				const m = line.match(/\+(\d+) -(\d+)/);
				if (m) {
					ahead = Number(m[1]);
					behind = Number(m[2]);
				}
				continue;
			}
			if (line.startsWith("# ")) continue;
			const type = line[0];
			if (type === "?") {
				files.push({ path: line.slice(2), indexStatus: " ", workStatus: "?", kind: "untracked" });
				continue;
			}
			if (type === "!") continue;
			if (type === "1" || type === "2" || type === "u") {
				const parts = line.split(" ");
				const xy = parts[1] ?? "..";
				const x = xy[0] ?? ".";
				const y = xy[1] ?? ".";
				// 1: <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
				// 2: <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>  （NUL 后跟原路径，占下一条记录）
				// u: <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
				const pathIndex = type === "1" ? 8 : type === "2" ? 9 : 10;
				const filePath = parts.slice(pathIndex).join(" ");
				const fromPath = type === "2" ? records[i + 1] : undefined;
				if (type === "2") i += 1; // 跳过 rename 的原路径记录
				if (!filePath) continue;
				files.push({
					path: filePath,
					...(fromPath ? { from: fromPath } : {}),
					indexStatus: x === "." ? " " : x,
					workStatus: y === "." ? " " : y,
					kind: kindOf(x, y),
				});
			}
		}
	} catch (error) {
		// 分支与提交可继续展示，但文件状态未知，绝不能回退为「工作区干净」。
		const stderr = (error as { stderr?: unknown })?.stderr;
		statusError = (typeof stderr === "string" ? stderr.trim() : error instanceof Error ? error.message : String(error)) || "git status failed";
	}

	let commits: GitCommit[] = [];
	try {
		const log = await runGit(root, ["log", "-10", "--pretty=%h%x1f%s%x1f%an%x1f%cr"]);
		commits = log
			.split("\n")
			.filter(Boolean)
			.map((line) => {
				const [hash, subject, author, relative] = line.split("\x1f");
				return { hash, subject: subject ?? "", author: author ?? "", relative: relative ?? "" };
			});
	} catch {
		// 空仓库没有提交
	}

	if (branch === null && !detached) {
		try {
			branch = (await runGit(root, ["rev-parse", "--abbrev-ref", "HEAD"])).trim() || null;
		} catch {
			/* keep null */
		}
	}
	return { available: true, isRepo: true, root, branch, upstream, ahead, behind, detached, files, commits, ...(statusError ? { statusError } : {}) };
}

export interface GitDiffResult {
	patch: string;
	truncated: boolean;
	binary: boolean;
	/** 完整 diff 的 Git numstat，独立于用于展示的 patch 截断。二进制不计行数。 */
	stats: { add: number; del: number };
}

async function fullDiffStats(root: string, args: string[], noIndex = false): Promise<{ stats: GitDiffResult["stats"]; binary: boolean }> {
	let raw: string;
	try {
		raw = await runGit(root, args);
	} catch (error) {
		// --no-index 的退出码 1 表示有差异，stdout 仍是有效的 numstat。
		const result = error as { code?: number; stdout?: string };
		if (!noIndex || result.code !== 1 || typeof result.stdout !== "string" || !result.stdout) throw error;
		raw = result.stdout;
	}
	let add = 0;
	let del = 0;
	let binary = false;
	for (const entry of parseNumstat(raw).values()) {
		add += entry.add;
		del += entry.del;
		binary ||= entry.binary;
	}
	return { stats: { add, del }, binary };
}

/** 按字节截断时退到字符边界：直接 subarray 会把多字节字符切成半个，patch 末尾多出一个 U+FFFD */
function assertRepoRelative(root: string, relPath: unknown): string {
	if (typeof relPath !== "string" || !relPath.trim()) throw new BoundaryError("missing path");
	const abs = path.resolve(root, relPath);
	if (!isPathInside(root, abs)) throw new BoundaryError("path escapes the repository");
	return abs;
}

function assertCommitHash(hash: unknown): string {
	if (typeof hash !== "string" || !/^[0-9a-f]{4,40}$/i.test(hash)) throw new BoundaryError("invalid commit hash");
	return hash;
}

async function resolveRepo(cwdValue: unknown): Promise<string> {
	const cwd = await resolveWorkspacePath(cwdValue);
	const { available, root } = await repoRoot(cwd);
	if (!available || !root) throw new BoundaryError("not a git repository");
	return root;
}

/** 单文件差异：staged（索引 vs HEAD）、worktree（工作区 vs 索引）、untracked（整文件视为新增）、commit（指定提交内该文件） */
export async function gitDiff(
	cwdValue: unknown,
	relPath: unknown,
	mode: unknown,
	opts: { fullContext?: boolean; hash?: unknown; from?: unknown } = {},
): Promise<GitDiffResult> {
	const root = await resolveRepo(cwdValue);
	const abs = assertRepoRelative(root, relPath);
	const rel = path.relative(root, abs).replace(/\\/g, "/");
	const limitBytes = opts.fullContext ? MAX_FULL_DIFF_BYTES : MAX_DIFF_BYTES;
	const contextArgs = opts.fullContext ? ["-U1000000"] : [];

	if (mode === "untracked") {
		// 未跟踪文件：合成一个全新增的 patch，让前端用同一套 diff 视图展示
		const realRoot = await fs.realpath(root);
		const realFile = await fs.realpath(abs).catch(() => { throw new BoundaryError("file not found"); });
		if (!isPathInside(realRoot, realFile)) throw new BoundaryError("path escapes the repository");
		const stat = await fs.stat(realFile).catch(() => null);
		if (!stat?.isFile()) throw new BoundaryError("file not found");
		const { stats, binary } = await fullDiffStats(root, ["diff", "--no-index", "--no-ext-diff", "--no-textconv", "--numstat", "-z", "--", "/dev/null", realFile], true);
		if (binary) return { patch: "", truncated: false, binary: true, stats };
		const buffer = Buffer.alloc(Math.min(stat.size, limitBytes + 1));
		const handle = await fs.open(realFile, "r");
		let bytesRead = 0;
		try {
			while (bytesRead < buffer.length) {
				const read = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
				if (read.bytesRead === 0) break;
				bytesRead += read.bytesRead;
			}
		} finally {
			await handle.close();
		}
		const head = buffer.subarray(0, bytesRead);
		const text = utf8Prefix(head, limitBytes).toString("utf8").replace(/\r\n/g, "\n");
		const lines = text.split("\n");
		if (lines[lines.length - 1] === "") lines.pop();
		const body = lines.map((l) => `+${l}`).join("\n");
		return {
			patch: `--- /dev/null\n+++ b/${rel}\n@@ -0,0 +1,${lines.length} @@\n${body}\n`,
			truncated: stat.size > limitBytes,
			binary: false,
			stats,
		};
	}

	if (mode === "commit") {
		const hash = assertCommitHash(opts.hash);
		const paths = [rel];
		if (typeof opts.from === "string" && opts.from.trim()) {
			const fromAbs = assertRepoRelative(root, opts.from);
			paths.push(path.relative(root, fromAbs).replace(/\\/g, "/"));
		}
		const baseArgs = ["show", "--diff-merges=first-parent", "-M", "--no-ext-diff", "--no-textconv", "--format="];
		const [out, counts] = await Promise.all([
			runGitPatch(root, [...baseArgs, "--no-color", ...contextArgs, "--patch", hash, "--", ...paths], limitBytes),
			fullDiffStats(root, [...baseArgs, "--numstat", "-z", hash, "--", ...paths]),
		]);
		if (counts.binary && !out.patch.includes("@@ ")) return { patch: "", truncated: false, binary: true, stats: counts.stats };
		return { ...out, binary: false, stats: counts.stats };
	}

	const paths = [rel];
	if (mode === "staged" && typeof opts.from === "string" && opts.from.trim()) {
		const fromAbs = assertRepoRelative(root, opts.from);
		paths.push(path.relative(root, fromAbs).replace(/\\/g, "/"));
	}
	const scope = mode === "staged" ? ["--cached", "-M"] : ["--ours"];
	const [out, counts] = await Promise.all([
		runGitPatch(root, ["diff", ...scope, "--no-color", "--no-ext-diff", "--no-textconv", ...contextArgs, "--", ...paths], limitBytes),
		fullDiffStats(root, ["diff", ...scope, "--no-ext-diff", "--no-textconv", "--numstat", "-z", "--", ...paths]),
	]);
	if (counts.binary) return { patch: "", truncated: false, binary: true, stats: counts.stats };
	return { ...out, binary: false, stats: counts.stats };
}

/** 单次提交的改动文件清单（用于右侧 GitPanel 展开点击进 FileViewer） */
export async function gitCommitFiles(cwdValue: unknown, hashValue: unknown): Promise<{ hash: string; title: string; files: GitCommitFile[] }> {
	const root = await resolveRepo(cwdValue);
	const hash = assertCommitHash(hashValue);
	const [title, nameStatusRaw, numstatRaw] = await Promise.all([
		runGit(root, ["log", "-1", "--pretty=%h %s%n%an · %cr", hash]),
		runGit(root, ["show", "--diff-merges=first-parent", "-M", "--name-status", "-z", "--format=", hash]),
		runGit(root, ["show", "--diff-merges=first-parent", "-M", "--numstat", "-z", "--format=", hash]),
	]);
	const statsMap = parseNumstat(numstatRaw);
	const files: GitCommitFile[] = [];
	const tokens = nameStatusRaw.split("\0");
	for (let i = 0; i < tokens.length; i += 1) {
		const code = tokens[i];
		if (!code) continue;
		const statusLetter = code[0];
		if (statusLetter === "R" || statusLetter === "C") {
			const from = tokens[i + 1];
			const to = tokens[i + 2];
			i += 2;
			if (!to) continue;
			const st = statsMap.get(to);
			files.push({ path: to, from, status: statusLetter, add: st?.add ?? 0, del: st?.del ?? 0, binary: st?.binary ?? false });
		} else if (statusLetter === "A" || statusLetter === "M" || statusLetter === "D") {
			const filePath = tokens[i + 1];
			i += 1;
			if (!filePath) continue;
			const st = statsMap.get(filePath);
			files.push({ path: filePath, status: statusLetter, add: st?.add ?? 0, del: st?.del ?? 0, binary: st?.binary ?? false });
		}
	}
	return { hash, title: title.trim(), files };
}

/** 读取某个 Git 对象版本中的单文件文本（用于 FileViewer 查看提交历史/已删文件正文） */
export async function gitFileContent(cwdValue: unknown, relPath: unknown, revValue: unknown): Promise<DecodedFilePreview & { truncated: boolean; size: number }> {
	const root = await resolveRepo(cwdValue);
	const abs = assertRepoRelative(root, relPath);
	const rel = path.relative(root, abs).replace(/\\/g, "/");
	const rev = typeof revValue === "string" && revValue === "INDEX"
		? ":0"
		: typeof revValue === "string" && revValue === "HEAD"
			? "HEAD"
			: assertCommitHash(revValue);
	const git = await resolveGitBin();
	const bytes = await new Promise<Buffer>((resolve, reject) => {
		const child = spawn(git, [...SAFE_GIT_ARGS, "cat-file", "-p", `${rev}:${rel}`], {
			cwd: root,
			windowsHide: true,
			env: gitEnvironment(root, true),
			stdio: ["ignore", "pipe", "pipe"],
		});
		const chunks: Buffer[] = [];
		let stderr = "";
		let settled = false;
		const finish = (err?: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (err) reject(err);
			else resolve(Buffer.concat(chunks));
		};
		const timer = setTimeout(() => { child.kill(); finish(new Error("git cat-file timed out")); }, 15_000);
		child.stdout.on("data", (c: Buffer) => chunks.push(c));
		child.stderr.on("data", (c: Buffer) => { stderr = (stderr + c.toString("utf8")).slice(-4096); });
		child.on("error", finish);
		child.on("close", (code) => finish(code === 0 ? undefined : new GitActionError(stderr.trim() || "该版本中不存在此文件", 404)));
	});
	const truncated = bytes.length > MAX_CONTENT_BYTES;
	return { ...decodeFilePreview(bytes, MAX_CONTENT_BYTES, truncated), truncated, size: bytes.length };
}

/** 单次提交的内容（含各文件 patch） */
export async function gitShow(cwdValue: unknown, hash: unknown): Promise<GitDiffResult & { title: string }> {
	const root = await resolveRepo(cwdValue);
	const validHash = assertCommitHash(hash);
	const title = (await runGit(root, ["log", "-1", "--pretty=%h %s%n%an · %cr", validHash])).trim();
	const [out, counts] = await Promise.all([
		runGitPatch(root, ["show", "--diff-merges=first-parent", "--no-color", "--no-ext-diff", "--no-textconv", "--format=", "--patch", validHash]),
		fullDiffStats(root, ["show", "--diff-merges=first-parent", "--no-ext-diff", "--no-textconv", "--format=", "--numstat", "-z", validHash]),
	]);
	return { title, ...out, stats: counts.stats, binary: counts.binary && !out.patch.includes("@@ ") };
}

async function hasHeadCommit(root: string): Promise<boolean> {
	try {
		await runGit(root, ["rev-parse", "--verify", "-q", "HEAD"]);
		return true;
	} catch {
		return false;
	}
}

function normalizeRepoPaths(root: string, paths: unknown): string[] {
	if (!Array.isArray(paths) || paths.length === 0) throw new BoundaryError("missing paths");
	const set = new Set<string>();
	for (const p of paths) {
		const abs = assertRepoRelative(root, p);
		set.add(path.relative(root, abs).replace(/\\/g, "/"));
	}
	return [...set];
}

function mapGitWriteError(error: unknown, fallback: string): GitActionError {
	if (error instanceof GitActionError || error instanceof BoundaryError) throw error;
	const msg = error instanceof Error ? error.message : String(error);
	if (/index\.lock/i.test(msg)) return new GitActionError("Git 索引被其他进程锁定，请稍后再试", 409);
	if (/Author identity unknown|Please tell me who you are/i.test(msg)) {
		return new GitActionError("未配置 Git 用户身份（user.name / user.email），请先执行 git config 后重试", 400);
	}
	if (/nothing to commit|no changes added/i.test(msg)) return new GitActionError("暂存区为空，请先暂存要提交的改动", 400);
	if (/conflict|unmerged/i.test(msg)) return new GitActionError(`存在未解决的冲突：${msg}`, 409);
	return new GitActionError(msg || fallback, 400);
}

/** 暂存指定文件或全部工作区改动 */
export async function gitStage(cwdValue: unknown, target: "all" | string[]): Promise<void> {
	const root = await resolveRepo(cwdValue);
	const rels = target === "all" ? null : normalizeRepoPaths(root, target);
	await withRepoLock(root, async () => {
		try {
			if (rels === null) await runGitCommand(root, ["add", "-A"]);
			else await runGitCommand(root, ["add", "-A", "--", ...rels]);
		} catch (err) {
			throw mapGitWriteError(err, "暂存失败");
		}
	});
}

/** 取消暂存指定文件或全部已暂存改动（兼容空仓库 unborn HEAD） */
export async function gitUnstage(cwdValue: unknown, target: "all" | string[]): Promise<void> {
	const root = await resolveRepo(cwdValue);
	const rels = target === "all" ? null : normalizeRepoPaths(root, target);
	await withRepoLock(root, async () => {
		try {
			const hasHead = await hasHeadCommit(root);
			if (hasHead) {
				if (rels === null) await runGitCommand(root, ["reset", "-q", "HEAD"]);
				else await runGitCommand(root, ["reset", "-q", "HEAD", "--", ...rels]);
			} else if (rels === null) {
				await runGitCommand(root, ["rm", "-r", "--cached", "--ignore-unmatch", "-q", "."]);
			} else {
				await runGitCommand(root, ["rm", "-r", "--cached", "--ignore-unmatch", "-q", "--", ...rels]);
			}
		} catch (err) {
			throw mapGitWriteError(err, "取消暂存失败");
		}
	});
}

function verifyAnchorMatches(actual: RawHunkAnchor, expected?: Partial<RawHunkAnchor>): boolean {
	if (!expected) return true;
	if (typeof expected.oldAnchor === "number" && actual.oldAnchor !== expected.oldAnchor) return false;
	if (typeof expected.newAnchor === "number" && actual.newAnchor !== expected.newAnchor) return false;
	if (typeof expected.delCount === "number" && actual.delCount !== expected.delCount) return false;
	if (typeof expected.addCount === "number" && actual.addCount !== expected.addCount) return false;
	return true;
}

/** 按块暂存 / 取消暂存单个变更块 */
export async function gitHunkAction(
	cwdValue: unknown,
	relPath: unknown,
	action: "stageHunk" | "unstageHunk",
	mode: unknown,
	blockIndex: number,
	expectedAnchor?: Partial<RawHunkAnchor>,
): Promise<void> {
	if (!Number.isInteger(blockIndex) || blockIndex < 0) throw new BoundaryError("invalid hunk index");
	const root = await resolveRepo(cwdValue);
	const abs = assertRepoRelative(root, relPath);
	const rel = path.relative(root, abs).replace(/\\/g, "/");

	await withRepoLock(root, async () => {
		try {
			if (action === "stageHunk" && mode === "untracked") {
				if (blockIndex !== 0) throw new GitActionError("该差异块不存在，请刷新后重试", 409);
				await runGitCommand(root, ["add", "--", rel]);
				return;
			}
			const scope = action === "unstageHunk" ? ["--cached", "--no-renames"] : ["--ours", "--no-renames"];
			const rawBuf = await runGitRawStdout(root, ["diff", ...scope, "--no-color", "--no-ext-diff", "--no-textconv", "-U1000000", "--", rel]);
			const rawPatch = rawBuf.toString("utf8");
			if (!rawPatch.trim()) throw new GitActionError("该差异块已不存在，请刷新后重试", 409);

			const parsed = parseRawPatchBlocks(rawPatch);
			const block = parsed.blocks[blockIndex];
			if (!block || !verifyAnchorMatches(block.anchor, expectedAnchor)) {
				throw new GitActionError("文件内容已变化，差异块定位已失效，请刷新后重试", 409);
			}

			// 整块就是新建文件的全部暂存内容且在空仓库时，直接走 git rm --cached 最稳妥
			if (action === "unstageHunk" && parsed.blocks.length === 1 && parsed.headerLines.some((l) => l.startsWith("new file mode "))) {
				const hasHead = await hasHeadCommit(root);
				if (!hasHead) {
					await runGitCommand(root, ["rm", "--cached", "-q", "--", rel]);
					return;
				}
			}

			const singlePatch = buildSingleHunkPatch(parsed, blockIndex);
			const applyArgs = action === "unstageHunk"
				? ["apply", "--cached", "--reverse", "--unidiff-zero", "-"]
				: ["apply", "--cached", "--unidiff-zero", "-"];
			await runGitCommand(root, applyArgs, { input: singlePatch });
		} catch (err) {
			if (err instanceof GitActionError || err instanceof BoundaryError) throw err;
			const msg = err instanceof Error ? err.message : String(err);
			if (/patch does not apply|corrupt patch/i.test(msg)) {
				throw new GitActionError("按块应用失败，文件内容可能已发生变化，请刷新后重试", 409);
			}
			throw mapGitWriteError(err, action === "stageHunk" ? "按块暂存失败" : "按块取消暂存失败");
		}
	});
}

async function runPushInternal(root: string): Promise<string> {
	const infoBranch = await runGit(root, ["rev-parse", "--abbrev-ref", "HEAD"]).then((s) => s.trim(), () => "");
	const hasUpstream = await runGit(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]).then(
		() => true,
		() => false,
	);
	if (!hasUpstream) {
		if (!infoBranch || infoBranch === "HEAD") throw new GitActionError("当前处于分离头指针状态，无法自动推送", 400);
		const remotes = (await runGit(root, ["remote"])).split(/\r?\n/).map((r) => r.trim()).filter(Boolean);
		if (remotes.length === 0) throw new GitActionError("当前仓库尚未配置远程仓库（remote）", 400);
		const targetRemote = remotes.includes("origin") ? "origin" : remotes.length === 1 ? remotes[0] : "";
		if (!targetRemote) throw new GitActionError(`当前分支无上游分支且存在多个远端（${remotes.join(", ")}），请先手动设置上游`, 400);
		const { stdout, stderr } = await runGitCommand(root, ["push", "-u", targetRemote, infoBranch], { allowHooks: true, timeoutMs: 60_000 });
		return (stdout || stderr).trim();
	}
	const { stdout, stderr } = await runGitCommand(root, ["push"], { allowHooks: true, timeoutMs: 60_000 });
	return (stdout || stderr).trim();
}

/** 提交暂存区改动；可选顺带推送 */
export async function gitCommit(
	cwdValue: unknown,
	messageValue: unknown,
	opts: { push?: boolean } = {},
): Promise<{ hash: string; summary: string; pushed?: boolean; pushOutput?: string; pushError?: string }> {
	if (typeof messageValue !== "string" || !messageValue.trim()) throw new GitActionError("请输入提交说明", 400);
	const root = await resolveRepo(cwdValue);
	return withRepoLock(root, async () => {
		try {
			const stagedNames = (await runGit(root, ["diff", "--cached", "--name-only"])).trim();
			if (!stagedNames) throw new GitActionError("暂存区为空，请先暂存要提交的改动", 400);
			await runGitCommand(root, ["commit", "-F", "-"], { input: messageValue, allowHooks: true, timeoutMs: 30_000 });
			const hash = (await runGit(root, ["rev-parse", "--short", "HEAD"])).trim();
			const summary = (await runGit(root, ["log", "-1", "--pretty=%s", "HEAD"])).trim();
			if (!opts.push) return { hash, summary };
			try {
				const pushOutput = await runPushInternal(root);
				return { hash, summary, pushed: true, ...(pushOutput ? { pushOutput } : {}) };
			} catch (pushErr) {
				const pushError = pushErr instanceof Error ? pushErr.message : String(pushErr);
				return { hash, summary, pushed: false, pushError };
			}
		} catch (err) {
			throw mapGitWriteError(err, "提交失败");
		}
	});
}

/** 推送当前分支 */
export async function gitPush(cwdValue: unknown): Promise<{ output: string }> {
	const root = await resolveRepo(cwdValue);
	return withRepoLock(root, async () => {
		try {
			return { output: await runPushInternal(root) };
		} catch (err) {
			throw mapGitWriteError(err, "推送失败");
		}
	});
}

/** 拉取当前分支 */
export async function gitPull(cwdValue: unknown): Promise<{ output: string }> {
	const root = await resolveRepo(cwdValue);
	return withRepoLock(root, async () => {
		try {
			const { stdout, stderr } = await runGitCommand(root, ["pull"], { allowHooks: true, timeoutMs: 60_000 });
			return { output: (stdout || stderr).trim() };
		} catch (err) {
			throw mapGitWriteError(err, "拉取失败");
		}
	});
}
