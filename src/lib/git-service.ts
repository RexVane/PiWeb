/**
 * git-service：会话工作区的 Git 状态与差异（详情栏「Git」面板）。
 * 只读：porcelain v2 状态、最近提交、单文件差异、单次提交内容；不做任何写操作。
 * 所有 git 命令以仓库根为 cwd 运行，因为 porcelain 输出的路径都相对仓库根。
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { BoundaryError, isPathInside, resolveWorkspacePath } from "./path-security";

const exec = promisify(execFile);

export interface GitFileEntry {
	path: string;
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

/** 单次差异输出上限：超过则截断并标记（详情栏不是完整的 diff 工具） */
const MAX_DIFF_BYTES = 400 * 1024;

function runGit(cwd: string, args: string[], maxBuffer = 4 * 1024 * 1024): Promise<string> {
	return exec("git", args, { cwd, timeout: 15_000, maxBuffer, windowsHide: true }).then((r) => r.stdout);
}

function kindOf(x: string, y: string): GitFileEntry["kind"] {
	if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) return "conflict";
	const letter = x !== "." ? x : y;
	if (letter === "A") return "added";
	if (letter === "D") return "deleted";
	if (letter === "R" || letter === "C") return "renamed";
	return "modified";
}

async function repoRoot(cwd: string): Promise<{ available: boolean; root: string | null }> {
	try {
		const out = (await runGit(cwd, ["rev-parse", "--show-toplevel"])).trim();
		return { available: true, root: out ? path.resolve(out) : null };
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return { available: false, root: null };
		// exit 128：不是仓库
		return { available: true, root: null };
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
	const files: GitFileEntry[] = [];
	try {
		// porcelain v2 是结构化输出，不依赖 "No branch" 这类措辞；-z 让含空格/非 ASCII 的路径也稳定
		const status = await runGit(root, ["status", "--porcelain=v2", "--branch", "-z"]);
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
				if (type === "2") i += 1; // 跳过 rename 的原路径记录
				if (!filePath) continue;
				files.push({
					path: filePath,
					indexStatus: x === "." ? " " : x,
					workStatus: y === "." ? " " : y,
					kind: kindOf(x, y),
				});
			}
		}
	} catch {
		// status 失败（如索引损坏）：分支与提交仍可展示
	}

	let commits: GitCommit[] = [];
	try {
		const log = await runGit(root, ["log", "-10", "--pretty=%h%x1f%s%x1f%an%x1f%cr"]);
		commits = log
			.split("\n")
			.filter(Boolean)
			.map((line) => {
				const [hash, subject, author, relative] = line.split("");
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
	return { available: true, isRepo: true, root, branch, upstream, ahead, behind, detached, files, commits };
}

export interface GitDiffResult {
	patch: string;
	truncated: boolean;
	binary: boolean;
}

function truncate(patch: string): GitDiffResult {
	if (Buffer.byteLength(patch) <= MAX_DIFF_BYTES) return { patch, truncated: false, binary: false };
	return { patch: Buffer.from(patch).subarray(0, MAX_DIFF_BYTES).toString("utf8"), truncated: true, binary: false };
}

function assertRepoRelative(root: string, relPath: unknown): string {
	if (typeof relPath !== "string" || !relPath.trim()) throw new BoundaryError("missing path");
	const abs = path.resolve(root, relPath);
	if (!isPathInside(root, abs)) throw new BoundaryError("path escapes the repository");
	return abs;
}

/** 单文件差异：staged（索引 vs HEAD）、worktree（工作区 vs 索引）、untracked（整文件视为新增） */
export async function gitDiff(cwdValue: unknown, relPath: unknown, mode: unknown): Promise<GitDiffResult> {
	const cwd = await resolveWorkspacePath(cwdValue);
	const { available, root } = await repoRoot(cwd);
	if (!available || !root) throw new BoundaryError("not a git repository");
	const abs = assertRepoRelative(root, relPath);
	const rel = path.relative(root, abs).replace(/\\/g, "/");
	if (mode === "untracked") {
		// 未跟踪文件：合成一个全新增的 patch，让前端用同一套 diff 视图展示
		const stat = await fs.stat(abs).catch(() => null);
		if (!stat?.isFile()) throw new BoundaryError("file not found");
		const buffer = await fs.readFile(abs);
		if (buffer.includes(0)) return { patch: "", truncated: false, binary: true };
		const text = buffer.subarray(0, MAX_DIFF_BYTES).toString("utf8").replace(/\r/g, "");
		const lines = text.split("\n");
		if (lines[lines.length - 1] === "") lines.pop();
		const body = lines.map((l) => `+${l}`).join("\n");
		return {
			patch: `--- /dev/null\n+++ b/${rel}\n@@ -0,0 +1,${lines.length} @@\n${body}\n`,
			truncated: buffer.length > MAX_DIFF_BYTES,
			binary: false,
		};
	}
	const args = mode === "staged" ? ["diff", "--cached", "--no-color", "--", rel] : ["diff", "--no-color", "--", rel];
	const out = await runGit(root, args, 8 * 1024 * 1024);
	if (/^Binary files .* differ$/m.test(out)) return { patch: "", truncated: false, binary: true };
	return truncate(out);
}

/** 单次提交的内容（含各文件 patch） */
export async function gitShow(cwdValue: unknown, hash: unknown): Promise<GitDiffResult & { title: string }> {
	const cwd = await resolveWorkspacePath(cwdValue);
	const { available, root } = await repoRoot(cwd);
	if (!available || !root) throw new BoundaryError("not a git repository");
	if (typeof hash !== "string" || !/^[0-9a-f]{4,40}$/i.test(hash)) throw new BoundaryError("invalid commit hash");
	const title = (await runGit(root, ["log", "-1", "--pretty=%h %s%n%an · %cr", hash])).trim();
	const out = await runGit(root, ["show", "--no-color", "--format=", "--patch", hash], 8 * 1024 * 1024);
	return { title, ...truncate(out) };
}
