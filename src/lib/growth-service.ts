/**
 * growth-service：项目生长 = 每轮一个 git commit（工作区自带 git，无影子仓库、无旁路账本）。
 *
 * commit 直接落在工作区自己的 git 仓库里：非 git 目录在首次提交前自动 `git init`；
 * 工作区若只是别的仓库的子目录，则在自身根目录嵌套 init，保证记录范围恰好等于工作区。
 * 每轮结束 = 往 PiWeb 独立暂存区 <gitdir>/piweb/index（GIT_INDEX_FILE 传入）add 全部改动，
 * write-tree + commit-tree，挂到专用引用 refs/piweb/rounds/<key>：不碰 HEAD、不碰用户暂存区、不占分支。
 * 排除规则 <gitdir>/piweb/exclude 只叠加、绝不改写用户的 info/exclude。
 *
 * 元信息全部在 commit 里：标题是本轮提问首行，Piweb-Kind / Session / Prompts / Status 写成 trailers。
 * 时间轴 = 一次 `git log --raw --numstat` 读回（每轮相对上一轮的增删改与行数）；
 * 任意两轮任意文件用 git diff 得行级 patch，cat-file 取任意一轮的全文。
 * 工作区的 .gitignore / info/exclude / 全局 excludesFile 与生成的排除文件都生效；
 * 没有 git、目录不可写或项目过大时本会话停用跟踪。
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { GROWTH_EXCLUDE_DIRS } from "./growth-tree";
import type { GrowthChange, GrowthRound, GrowthRoundKind, GrowthRoundStatus } from "./types";

/** 单文件快照上限：超过的不进快照（树里也就看不到它） */
export const MAX_FILE_BYTES = 1024 * 1024;
/** 单次 patch 输出上限 */
const MAX_PATCH_BYTES = 4 * 1024 * 1024;
/** 单文件全文预览上限 */
const MAX_CONTENT_BYTES = 256 * 1024;
/** 防止意外把依赖/缓存目录完整哈希入库，导致工作区长时间卡住。 */
const MAX_CANDIDATES = 50_000;
/** 每轮最多列多少条变更；更多的由前端按 tree 对再取 */
const MAX_CHANGES_PER_ROUND = 2000;
/** 每轮 commit 链的专用引用前缀：每个工作区一条 refs/piweb/rounds/<key>，多 worktree 互不覆盖 */
const GROWTH_REF_PREFIX = "refs/piweb/rounds";
/** 时间轴读取的记录分隔符（git log --format 里的 %x1e / %x1f） */
const RECORD_SEP = "\x1e";
const FIELD_SEP = "\x1f";

/** 不进快照的目录 / 文件（写进 <gitdir>/piweb/exclude）；工作区自己的 .gitignore 等同样生效 */
export const EXCLUDE_DIRS = GROWTH_EXCLUDE_DIRS;
const EXCLUDE_FILES = [".DS_Store", "Thumbs.db", "*.log", ".env", ".env.*", "!.env.example", "*.pem", "*.key", "*.p12", "*.pfx", "id_rsa*", "id_ed25519*"];
const EXCLUDE_CONTENT = `# PiWeb growth snapshot exclusions (generated, do not edit)\n${[...EXCLUDE_DIRS.map((d) => `${d}/`), ...EXCLUDE_FILES].join("\n")}\n`;

export class GrowthError extends Error {
	constructor(
		message: string,
		public code: "unavailable" | "too-large" | "not-found" | "failed" = "failed",
	) {
		super(message);
		this.name = "GrowthError";
	}
}

interface WorkspaceState {
	key: string;
	cwd: string;
	/** 工作区自己的 git-dir（rev-parse --absolute-git-dir 解析，兼容 worktree 的 gitfile） */
	gitDir: string;
	/** PiWeb 专用暂存区（GIT_INDEX_FILE 传入）：用户自己的 index 永不触碰 */
	indexFile: string;
	/** PiWeb 专用排除文件（--exclude-from 传入）：不改写用户仓库的 info/exclude */
	excludeFile: string;
	/** 本工作区 commit 链的专用引用：refs/piweb/rounds/<key> */
	ref: string;
	/** 链头（最近一次提交）；没有提交过为 undefined */
	lastCommit?: string;
	lastTree?: string;
	/** 已从 git log 读回的整条链（时间正序）与读回时的链头；commit 不可变，链头没变就直接用 */
	rounds: GrowthRound[] | null;
	loadedHead?: string;
	emptyTree: string;
	excludeRules?: string;
	/** 同一工作区的快照串行执行（共用同一个 PiWeb 暂存区） */
	lock: Promise<unknown>;
}

interface Registry {
	workspaces: Map<string, Promise<WorkspaceState>>;
	gitOk?: Promise<boolean>;
	/** git 不可用的上次确认时间（否定结果短缓存，避免重复探测超时） */
	gitFailedAt?: number;
	/** 解析后的 git 可执行文件（macOS GUI PATH 兜底） */
	gitBin?: string;
}
// 键名带 Rounds：dev 热更新后不复用旧版（快照 + 账本）结构的工作区状态
const globalForGrowth = globalThis as typeof globalThis & { __piWebGrowthRounds?: Registry };
const registry: Registry = (globalForGrowth.__piWebGrowthRounds ??= { workspaces: new Map() });

// ---------- 基础工具 ----------

function comparablePath(p: string): string {
	const norm = path.resolve(p).replace(/\\/g, "/");
	return process.platform === "win32" ? norm.toLowerCase() : norm;
}

/** 工作区目录名：路径 slug + 8 位哈希（Windows 大小写不敏感）；用作引用后缀与注册表键 */
export function workspaceKey(cwd: string): string {
	// Canonicalize first: Windows may report an 8.3 short path (RUNNER~1) in one call and
	// the long path in another, and two spellings must not split one workspace's history.
	let resolved = path.resolve(cwd);
	try {
		resolved = realpathSync.native(resolved);
	} catch {
		/* the directory may not exist yet; the resolved path is stable enough */
	}
	const cmp = comparablePath(resolved);
	const slug = cmp.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").slice(-48).toLowerCase();
	return `${slug || "root"}-${createHash("sha1").update(cmp).digest("hex").slice(0, 8)}`;
}

interface RunResult {
	stdout: Buffer;
	stderr: string;
	code: number;
}

type Env = Record<string, string | undefined>;

/**
 * 解析 git 可执行文件：macOS GUI/launchd 启动的进程 PATH 常不含 Homebrew，
 * spawn("git") 会 ENOENT → 生长快照整体误判不可用。PATH 找不到时退回常见安装位置。
 * 只在非 Windows 生效；结果缓存到 registry（成功后不再变）。
 */
async function resolveGitBin(): Promise<string> {
	if (registry.gitBin) return registry.gitBin;
	let bin = "git";
	if (process.platform !== "win32") {
		const candidates = ["/opt/homebrew/bin/git", "/usr/local/bin/git", "/usr/bin/git", "/usr/local/git/bin/git"];
		const inPath = await new Promise<boolean>((resolve) => {
			const child = spawn("git", ["--version"], { stdio: "ignore" });
			child.on("error", () => resolve(false));
			child.on("close", (code) => resolve(code === 0));
		});
		if (!inPath) {
			for (const candidate of candidates) {
				const ok = await new Promise<boolean>((resolve) => {
					const child = spawn(candidate, ["--version"], { stdio: "ignore" });
					child.on("error", () => resolve(false));
					child.on("close", (code) => resolve(code === 0));
				});
				if (ok) {
					bin = candidate;
					break;
				}
			}
		}
	}
	registry.gitBin = bin;
	return bin;
}

function runGit(args: string[], opts: { cwd?: string; input?: Buffer | string; maxBuffer?: number; env?: Env } = {}): Promise<RunResult> {
	const maxBuffer = opts.maxBuffer ?? 64 * 1024 * 1024;
	return resolveGitBin().then(
		(gitBin) =>
			new Promise<RunResult>((resolve, reject) => {
				const child = spawn(gitBin, args, {
					cwd: opts.cwd,
					env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", ...opts.env },
					windowsHide: true,
					stdio: ["pipe", "pipe", "pipe"],
				});
				const out: Buffer[] = [];
				const err: Buffer[] = [];
				let size = 0;
				let settled = false;
				const timer = setTimeout(() => fail(new GrowthError("git timed out", "failed")), 30_000);
				const fail = (error: Error) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					child.kill();
					reject(error);
				};
				child.stdout.on("data", (chunk: Buffer) => {
					size += chunk.length;
					if (size > maxBuffer) {
						child.kill();
						fail(new GrowthError("git output exceeded the buffer limit", "too-large"));
						return;
					}
					out.push(chunk);
				});
				child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
				child.on("error", (error: NodeJS.ErrnoException) => {
					if (error.code === "ENOENT" && opts.cwd && !existsSync(opts.cwd)) fail(new GrowthError("workspace directory not found", "failed"));
					else fail(error.code === "ENOENT" ? new GrowthError("git is not installed", "unavailable") : error);
				});
				child.on("close", (code) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					resolve({ stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString("utf8"), code: code ?? -1 });
				});
				if (opts.input !== undefined) child.stdin.end(opts.input);
				else child.stdin.end();
			}),
	);
}

/** git 不可用时短时间缓存否定结果：避免每个会话重复 30s 超时把 UI 拖死 */
const GIT_FAIL_RETRY_MS = 60_000;

async function gitOk(): Promise<boolean> {
	if (registry.gitOk) return registry.gitOk;
	if (registry.gitFailedAt && Date.now() - registry.gitFailedAt < GIT_FAIL_RETRY_MS) return false;
	const check = runGit(["--version"]).then((r) => r.code === 0, () => false);
	registry.gitOk = check;
	void check.then((ok) => {
		registry.gitOk = undefined;
		if (ok) registry.gitFailedAt = undefined;
		else registry.gitFailedAt = Date.now();
	});
	return check;
}

/**
 * 快照命令基础配置：关掉换行转换与路径转义，输出按字节原样。
 * LFS 类 clean 过滤必须禁用：快照要存文件原始字节，而不是指针文本
 * （用户仓库的 .gitattributes + 全局 filter.lfs.* 配置会同时命中工作区仓库）。
 */
const BASE_CONFIG = [
	"-c", "core.autocrlf=false",
	"-c", "core.safecrlf=false",
	"-c", "core.quotepath=false",
	"-c", "core.fsmonitor=false",
	"-c", "core.untrackedCache=false",
	"-c", "filter.lfs.clean=",
	"-c", "filter.lfs.smudge=",
	"-c", "filter.lfs.process=",
	"-c", "filter.lfs.required=false",
];

/**
 * 工作区仓库命令：固定 git-dir / work-tree，一律使用 PiWeb 专用暂存区。
 * GIT_INDEX_FILE 对纯对象读取（cat-file/diff-tree…）无副作用，统一带上避免漏传。
 */
async function shadow(ws: WorkspaceState, args: string[], opts: { input?: Buffer | string; maxBuffer?: number; allowFail?: boolean; env?: Env } = {}): Promise<RunResult> {
	const base = ["--git-dir", ws.gitDir, "--work-tree", ws.cwd, ...BASE_CONFIG];
	const env: Env = { GIT_INDEX_FILE: ws.indexFile, ...opts.env };
	const r = await runGit([...base, ...args], { cwd: ws.cwd, input: opts.input, maxBuffer: opts.maxBuffer, env });
	if (r.code !== 0 && !opts.allowFail) {
		throw new GrowthError(`git ${args[0]} failed: ${r.stderr.trim().split("\n")[0] || `exit ${r.code}`}`);
	}
	return r;
}

function realpathSafe(p: string): string {
	try {
		return realpathSync.native(p);
	} catch {
		return p;
	}
}

/**
 * 不启动 git 进程解析工作区的 git-dir（只读快速路径）：
 * `.git` 是目录直接用，是文件则按 worktree/submodule 的 gitfile 解析。
 * 记录只可能写在「工作区自身仓库」里，父级仓库不在考虑范围。
 */
async function resolveGitDirFast(cwd: string): Promise<string | null> {
	const dotgit = path.join(cwd, ".git");
	const stat = await fs.stat(dotgit).catch(() => null);
	if (stat?.isDirectory()) return dotgit;
	if (stat?.isFile()) {
		const text = await fs.readFile(dotgit, "utf8").catch(() => "");
		const match = /^gitdir:[ \t]*(.+)$/m.exec(text);
		if (match) return path.resolve(cwd, match[1].trim());
	}
	return null;
}

/**
 * 不启动 git 进程判断专用引用是否存在：refs/ 之下的引用存在共享目录（linked worktree 的 commondir），
 * 可能是松散文件，也可能已被 git gc 打包进 packed-refs。
 */
async function refExistsFast(gitDir: string, ref: string): Promise<boolean> {
	const commondir = (await fs.readFile(path.join(gitDir, "commondir"), "utf8").catch(() => "")).trim();
	const common = commondir ? path.resolve(gitDir, commondir) : gitDir;
	if (await fs.stat(path.join(common, ...ref.split("/"))).then((s) => s.isFile(), () => false)) return true;
	const packed = await fs.readFile(path.join(common, "packed-refs"), "utf8").catch(() => "");
	return packed.split("\n").some((line) => line.endsWith(` ${ref}`));
}

/**
 * 解析工作区可用的 git-dir：工作区已是某仓库的工作树根就直接复用；
 * 否则（非 git 目录、或只是别的仓库的子目录）在工作区根 `git init`。
 * init 失败（目录不可写等）按终态处理，本会话停用生长跟踪。
 */
async function ensureGitDir(cwd: string): Promise<string> {
	const usable = async (): Promise<string | null> => {
		const r = await runGit(["rev-parse", "--absolute-git-dir", "--show-toplevel", "--is-bare-repository"], { cwd });
		if (r.code !== 0) return null;
		const [gitDir = "", top = "", bare = ""] = r.stdout.toString("utf8").split("\n").map((s) => s.trim());
		if (!gitDir || bare === "true" || !top) return null;
		// 快照范围必须恰好等于工作区：落在别的仓库的子目录里时，宁可嵌套 init 自己的仓库
		if (comparablePath(realpathSafe(top)) !== comparablePath(realpathSafe(cwd))) return null;
		return gitDir;
	};
	const existing = await usable();
	if (existing) return existing;
	const r = await runGit(["init", "-q"], { cwd });
	if (r.code !== 0) throw new GrowthError(`git init failed: ${r.stderr.trim().split("\n")[0] || `exit ${r.code}`}`, "unavailable");
	const created = await usable();
	if (!created) throw new GrowthError("workspace cannot be used as a git repository", "unavailable");
	return created;
}

/** 链头的 commit 与 tree；引用不存在返回 null（for-each-ref 对不存在的引用输出空、退出码 0） */
async function readHead(ws: WorkspaceState): Promise<{ commit: string; tree: string } | null> {
	const r = await shadow(ws, ["for-each-ref", "--format=%(objectname) %(tree)", ws.ref]);
	const [commit = "", tree = ""] = r.stdout.toString("utf8").trim().split(" ");
	return HASH_RE.test(commit) && HASH_RE.test(tree) ? { commit, tree } : null;
}

async function createWorkspace(cwd: string): Promise<WorkspaceState> {
	if (!(await gitOk())) throw new GrowthError("git is not installed", "unavailable");
	const key = workspaceKey(cwd);
	const gitDir = await ensureGitDir(cwd);
	const piwebDir = path.join(gitDir, "piweb");
	await fs.mkdir(piwebDir, { recursive: true });
	const ws: WorkspaceState = {
		key,
		cwd,
		gitDir,
		indexFile: path.join(piwebDir, "index"),
		excludeFile: path.join(piwebDir, "exclude"),
		ref: `${GROWTH_REF_PREFIX}/${key}`,
		rounds: null,
		emptyTree: "",
		lock: Promise.resolve(),
	};
	await fs.writeFile(ws.excludeFile, EXCLUDE_CONTENT, "utf8");
	const head = await readHead(ws);
	ws.lastCommit = head?.commit;
	ws.lastTree = head?.tree;
	const empty = await shadow(ws, ["hash-object", "-t", "tree", "--stdin"], { input: "" });
	ws.emptyTree = empty.stdout.toString("utf8").trim();
	return ws;
}

async function getWorkspace(cwdValue: string): Promise<WorkspaceState> {
	const cwd = await fs.realpath(path.resolve(cwdValue)).catch(() => path.resolve(cwdValue));
	const key = workspaceKey(cwd);
	let pending = registry.workspaces.get(key);
	if (pending) {
		// 工作区的 .git 可能在运行期间被用户删掉重建：缓存里的状态就指向不存在的 git-dir，
		// 之后每次提交都报 not a git repository。发现 HEAD 不在就丢掉缓存重建（链头从新仓库重新读）
		const ws = await pending.catch(() => null);
		const alive = ws ? await fs.stat(path.join(ws.gitDir, "HEAD")).then(() => true, () => false) : false;
		if (!alive) {
			registry.workspaces.delete(key);
			pending = undefined;
		}
	}
	if (!pending) {
		pending = createWorkspace(cwd);
		registry.workspaces.set(key, pending);
		pending.catch(() => registry.workspaces.delete(key));
	}
	return pending;
}

function withLock<T>(ws: WorkspaceState, fn: () => Promise<T>): Promise<T> {
	const run = ws.lock.then(fn, fn);
	ws.lock = run.then(() => undefined, () => undefined);
	return run;
}

const HASH_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
function assertHash(value: unknown, what = "hash"): string {
	if (typeof value !== "string" || !HASH_RE.test(value)) throw new GrowthError(`invalid ${what}`, "not-found");
	return value;
}

function assertRelPath(value: unknown): string {
	if (typeof value !== "string" || !value.trim()) throw new GrowthError("missing path", "not-found");
	const rel = value.replace(/\\/g, "/").replace(/^\.\//, "");
	if (rel.startsWith("/") || /^[A-Za-z]:\//.test(rel) || rel.split("/").some((seg) => seg === "..")) {
		throw new GrowthError("invalid path", "not-found");
	}
	return rel;
}

// ---------- 输出解析（导出供测试） ----------

/** `diff-tree -r -M --name-status -z` 输出 → 变更列表（R 带 from） */
export function parseNameStatus(raw: string): GrowthChange[] {
	const tokens = raw.split("\0");
	const out: GrowthChange[] = [];
	for (let i = 0; i < tokens.length; i += 1) {
		const status = tokens[i];
		if (!status) continue;
		const letter = status[0];
		if (letter === "R" || letter === "C") {
			const from = tokens[i + 1];
			const to = tokens[i + 2];
			i += 2;
			if (to === undefined) break;
			out.push(letter === "R" ? { status: "R", path: to, from } : { status: "A", path: to });
			continue;
		}
		const p = tokens[i + 1];
		i += 1;
		if (p === undefined) break;
		if (letter === "A" || letter === "M" || letter === "D") out.push({ status: letter, path: p });
		else if (letter === "T") out.push({ status: "M", path: p });
	}
	return out;
}

/** `diff-tree -r -M --numstat -z` 输出 → path → {add, del, binary}（重命名按新路径记） */
export function parseNumstat(raw: string): Map<string, { add: number; del: number; binary: boolean }> {
	const tokens = raw.split("\0");
	const out = new Map<string, { add: number; del: number; binary: boolean }>();
	for (let i = 0; i < tokens.length; i += 1) {
		const t = tokens[i];
		if (!t) continue;
		const [a, d, rest] = t.split("\t");
		if (a === undefined || d === undefined) continue;
		const binary = a === "-" || d === "-";
		const entry = { add: binary ? 0 : Number(a) || 0, del: binary ? 0 : Number(d) || 0, binary };
		if (rest === undefined || rest === "") {
			// 重命名：路径在后两个 token（old, new）
			const to = tokens[i + 2];
			i += 2;
			if (to !== undefined) out.set(to, entry);
			continue;
		}
		out.set(rest, entry);
	}
	return out;
}

export interface TreeFile {
	path: string;
	size: number;
}

/** `ls-tree -r -l -z` 输出 → 文件清单（只取 blob） */
export function parseLsTree(raw: string): TreeFile[] {
	const out: TreeFile[] = [];
	for (const entry of raw.split("\0")) {
		if (!entry) continue;
		const m = entry.match(/^(\d+) (\w+) ([0-9a-f]+) +(-|\d+)\t([\s\S]+)$/);
		if (!m || m[2] !== "blob") continue;
		out.push({ path: m[5], size: m[4] === "-" ? 0 : Number(m[4]) });
	}
	return out;
}

/** 把 numstat 的行数并进 name-status 的变更清单（重命名按新路径对齐），按路径排序 */
function withStats(changes: GrowthChange[], stats: Map<string, { add: number; del: number; binary: boolean }>): GrowthChange[] {
	for (const c of changes) {
		const s = stats.get(c.path);
		if (!s) continue;
		c.add = s.add;
		c.del = s.del;
		if (s.binary) c.binary = true;
	}
	return changes.sort((a, b) => a.path.localeCompare(b.path));
}

export interface LogCommit {
	commit: string;
	tree: string;
	parent: string | null;
	/** 提交时间（毫秒） */
	ts: number;
	message: string;
	/** 相对第一个父 commit 的变更（根 commit 为空：读取时关掉了 log.showRoot） */
	changes: GrowthChange[];
}

/**
 * `git log -z --raw --numstat -M --format=%x1e%H%x1f%T%x1f%P%x1f%ct%x1f%B%x1f` 输出 → 每个 commit 的元信息与变更。
 * 每条记录以 \x1e 开头；头部字段以 \x1f 分隔、以 "\x1f\0" 结束；之后（可选的 "\n"）是 NUL 分隔的
 * --raw 条目（":模式 模式 哈希 哈希 状态" 后跟路径，R/C 跟两个路径）与 --numstat 条目
 * （"增\t删\t路径"；重命名是 "增\t删\t" 后跟旧、新两个路径）。空 commit 没有条目。
 */
export function parseRoundLog(raw: string): LogCommit[] {
	const out: LogCommit[] = [];
	for (const record of raw.split(RECORD_SEP)) {
		if (!record) continue;
		const end = record.indexOf(`${FIELD_SEP}\0`);
		const header = end >= 0 ? record.slice(0, end) : record.replace(/[\x1f\0\n]+$/, "");
		const fields = header.split(FIELD_SEP);
		if (fields.length < 5) continue;
		const [commit, tree, parents, ct] = fields;
		const names: string[] = [];
		const nums: string[] = [];
		const tokens = end >= 0 ? record.slice(end + 2).replace(/^\n/, "").split("\0") : [];
		for (let i = 0; i < tokens.length; i += 1) {
			const token = tokens[i];
			if (!token) continue;
			if (token.startsWith(":")) {
				const status = token.slice(token.lastIndexOf(" ") + 1);
				const span = status[0] === "R" || status[0] === "C" ? 2 : 1;
				names.push(status, ...tokens.slice(i + 1, i + 1 + span));
				i += span;
			} else {
				const parts = token.split("\t");
				const span = parts.length === 3 && parts[2] === "" ? 2 : 0;
				nums.push(token, ...tokens.slice(i + 1, i + 1 + span));
				i += span;
			}
		}
		out.push({
			commit,
			tree,
			parent: parents.split(" ").filter(Boolean)[0] ?? null,
			ts: Number(ct) * 1000,
			message: fields.slice(4).join(FIELD_SEP),
			changes: withStats(parseNameStatus(`${names.join("\0")}\0`), parseNumstat(`${nums.join("\0")}\0`)),
		});
	}
	return out;
}

const ROUND_KINDS: readonly GrowthRoundKind[] = ["round", "user", "baseline"];
const ROUND_STATUSES: readonly GrowthRoundStatus[] = ["done", "aborted", "error"];
/** 没有提问文字（纯图片）或非 pi 轮次时的 commit 标题；读回时还原成空标题，界面用自己的文案 */
const DEFAULT_TITLES: Record<GrowthRoundKind, string> = { round: "piweb: round", user: "piweb: workspace changes", baseline: "piweb: baseline" };

/** commit message → 标题 + Piweb-* trailers */
export function parseRoundMessage(message: string): Pick<GrowthRound, "kind" | "title" | "session" | "promptIds" | "status"> {
	const lines = message.split("\n");
	const trailers = new Map<string, string>();
	for (const line of lines) {
		const m = /^Piweb-([A-Za-z]+):[ \t]*(.*)$/.exec(line.trim());
		if (m) trailers.set(m[1].toLowerCase(), m[2].trim());
	}
	const kind = ROUND_KINDS.find((k) => k === trailers.get("kind")) ?? "round";
	const status = ROUND_STATUSES.find((s) => s === trailers.get("status")) ?? "done";
	const first = (lines[0] ?? "").trim();
	return {
		kind,
		title: kind === "round" && first !== DEFAULT_TITLES.round ? first : "",
		session: trailers.get("session") ?? "",
		promptIds: (trailers.get("prompts") ?? "").split(",").map((id) => id.trim()).filter(Boolean),
		status,
	};
}

function cleanLine(value: string): string {
	return value.replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim();
}

function roundMessage(meta: RoundMeta, kind: GrowthRoundKind): string {
	// 按码点截断：不能把 emoji 的代理对切成半个
	const title = Array.from(cleanLine(meta.title ?? "")).slice(0, 72).join("") || DEFAULT_TITLES[kind];
	const lines = [title, "", `Piweb-Kind: ${kind}`, `Piweb-Session: ${cleanLine(sessionName(meta.session))}`];
	const ids = (meta.promptIds ?? []).filter((id) => /^[\w.:-]{1,128}$/.test(id));
	if (ids.length) lines.push(`Piweb-Prompts: ${ids.join(",")}`);
	lines.push(`Piweb-Status: ${meta.status ?? "done"}`);
	return `${lines.join("\n")}\n`;
}

/** 会话只记 JSONL 文件名：不把用户目录结构写进 commit */
function sessionName(sessionPath: string): string {
	return path.basename(sessionPath.replace(/\\/g, "/"));
}

function summarize(changes: GrowthChange[]): GrowthRound["stats"] {
	const stats = { added: 0, modified: 0, deleted: 0, renamed: 0, add: 0, del: 0 };
	for (const c of changes) {
		if (c.status === "A") stats.added += 1;
		else if (c.status === "M") stats.modified += 1;
		else if (c.status === "D") stats.deleted += 1;
		else stats.renamed += 1;
		stats.add += c.add ?? 0;
		stats.del += c.del ?? 0;
	}
	return stats;
}

// ---------- 快照 ----------

async function diffTreesRaw(ws: WorkspaceState, from: string, to: string): Promise<GrowthChange[]> {
	const [names, nums] = await Promise.all([
		shadow(ws, ["diff-tree", "-r", "-M", "--name-status", "-z", from, to]),
		shadow(ws, ["diff-tree", "-r", "-M", "--numstat", "-z", from, to]),
	]);
	return withStats(parseNameStatus(names.stdout.toString("utf8")), parseNumstat(nums.stdout.toString("utf8")));
}

/** 候选路径 → 更新 PiWeb 专用索引；返回本次处理的文件数 */
async function refreshIndex(ws: WorkspaceState): Promise<number> {
	// --exclude-standard 让工作区的 .gitignore / info/exclude / 全局 excludesFile 生效；
	// --exclude-from 叠加 PiWeb 自己的排除文件（用户仓库的 info/exclude 一个字节都不改）
	const excludeFrom = ws.excludeFile.replace(/\\/g, "/");
	const listed = await shadow(ws, ["ls-files", "-z", "--others", "--modified", "--deleted", "--exclude-standard", `--exclude-from=${excludeFrom}`]);
	const candidates = Array.from(new Set(listed.stdout.toString("utf8").split("\0").filter((p) => p && !p.endsWith("/"))));
	if (candidates.length > MAX_CANDIDATES) {
		const counts = new Map<string, number>();
		for (const candidate of candidates) {
			const parts = candidate.split("/");
			const group = parts.length > 1 ? parts.slice(0, 2).join("/") : "(root)";
			counts.set(group, (counts.get(group) ?? 0) + 1);
		}
		const largest = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([dir, count]) => `${dir}: ${count}`).join(", ");
		throw new GrowthError(`snapshot has ${candidates.length} candidate files (limit ${MAX_CANDIDATES}); largest directories: ${largest}. Exclude generated directories with .gitignore`, "too-large");
	}
	const adds: string[] = [];
	const removals: string[] = [];
	const BATCH = 256;
	const INDEX_BATCH = 256;
	const directories = new Map<string, Promise<boolean>>();
	const regularDirectory = (rel: string): Promise<boolean> => {
		if (!rel) return Promise.resolve(true);
		const cached = directories.get(rel);
		if (cached) return cached;
		const check = (async () => {
			const parent = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
			if (!(await regularDirectory(parent))) return false;
			const stat = await fs.lstat(path.join(ws.cwd, rel)).catch((error: NodeJS.ErrnoException) => {
				if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
				throw error;
			});
			return Boolean(stat?.isDirectory() && !stat.isSymbolicLink());
		})();
		directories.set(rel, check);
		return check;
	};
	// 先分类全部候选，不能在 lstat 批次内穿插 add：冲突路径可能落在后续批次。
	for (let i = 0; i < candidates.length; i += BATCH) {
		const classified = await Promise.all(
			candidates.slice(i, i + BATCH).map(async (rel) => {
				// Git for Windows 会枚举 junction 内的文件；只查叶子 lstat 无法发现它。
				const parent = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
				if (!(await regularDirectory(parent))) return { rel, include: false };
				const stat = await fs.lstat(path.join(ws.cwd, rel)).catch((error: NodeJS.ErrnoException) => {
					if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
					throw error;
				});
				return { rel, include: Boolean(stat?.isFile() && stat.size <= MAX_FILE_BYTES) };
			}),
		);
		for (const { rel, include } of classified) (include ? adds : removals).push(rel);
	}
	// --remove 只移除磁盘上已消失的路径；符号链接/目录/超大文件仍在，必须 force-remove。
	// 全体移除先完成，保证 p → p/child 和 p/child → p 都不受候选顺序、批次边界影响。
	for (let i = 0; i < removals.length; i += INDEX_BATCH) {
		await shadow(ws, ["update-index", "--force-remove", "-z", "--stdin"], { input: `${removals.slice(i, i + INDEX_BATCH).join("\0")}\0` });
	}
	for (let i = 0; i < adds.length; i += INDEX_BATCH) {
		// Git 的 --replace 只移除与待添加项冲突的索引项，兜底扫描期间的类型转换；
		// --remove 同时容忍 lstat 后刚被删掉的文件。这些命令始终只操作 PiWeb 专用索引。
		await shadow(ws, ["update-index", "--add", "--remove", "--replace", "-z", "--stdin"], { input: `${adds.slice(i, i + INDEX_BATCH).join("\0")}\0` });
	}
	return candidates.length;
}

export interface RoundMeta {
	/** user 在工作区还没有任何提交时自动记成 baseline */
	kind: GrowthRoundKind;
	/** 会话 JSONL 路径（commit 里只记文件名） */
	session: string;
	/** round：本轮提问首行 */
	title?: string;
	promptIds?: string[];
	status?: GrowthRoundStatus;
}

/**
 * 提交一个 commit 到 refs/piweb/rounds/<key>（做法等同 git add -A + git commit，但只用 PiWeb 独立暂存区）。
 * pi 的一轮无论有没有改动都提交（空 commit 也算一轮，轮号与对话一一对应）；
 * 用户修改 / 基线只在工作区相对上一个 commit 有变化时提交，否则返回 null。
 */
export async function commitRound(cwdValue: string, meta: RoundMeta): Promise<GrowthRound | null> {
	const ws = await getWorkspace(cwdValue);
	return withLock(ws, async () => {
		if (ws.excludeRules !== EXCLUDE_CONTENT) {
			await fs.writeFile(ws.excludeFile, EXCLUDE_CONTENT, "utf8");
			ws.excludeRules = EXCLUDE_CONTENT;
		}
		await refreshIndex(ws);
		const tree = (await shadow(ws, ["write-tree"])).stdout.toString("utf8").trim();
		assertHash(tree, "tree");
		const env = {
			GIT_AUTHOR_NAME: "PiWeb", GIT_AUTHOR_EMAIL: "piweb@localhost",
			GIT_COMMITTER_NAME: "PiWeb", GIT_COMMITTER_EMAIL: "piweb@localhost",
		};
		for (let attempt = 0; ; attempt += 1) {
			const parent = ws.lastCommit;
			const kind: GrowthRoundKind = meta.kind === "user" && !parent ? "baseline" : meta.kind;
			if (kind !== "round" && parent && tree === ws.lastTree) return null;
			const commit = (await shadow(ws, ["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-F", "-"], { env, input: roundMessage(meta, kind) })).stdout.toString("utf8").trim();
			assertHash(commit, "commit");
			// 带旧值校验：另一个 PiWeb 进程抢先提交时不覆盖它，按新的链头重挂
			const updated = await shadow(ws, ["update-ref", ws.ref, commit, parent ?? ""], { allowFail: true });
			if (updated.code !== 0) {
				const head = await readHead(ws);
				if (attempt >= 2 || head?.commit === parent) {
					throw new GrowthError(`git update-ref failed: ${updated.stderr.trim().split("\n")[0] || `exit ${updated.code}`}`);
				}
				ws.lastCommit = head?.commit;
				ws.lastTree = head?.tree;
				continue;
			}
			const parentTree = parent ? ws.lastTree ?? ws.emptyTree : ws.emptyTree;
			// 链上第一个 commit 没有上一版可比：不把整个工作区算成「新增」
			const all = parent ? await diffTreesRaw(ws, parentTree, tree) : [];
			const changes = all.slice(0, MAX_CHANGES_PER_ROUND);
			const round: GrowthRound = {
				commit,
				parent: parent ?? null,
				tree,
				parentTree,
				ts: Date.now(),
				...parseRoundMessage(roundMessage(meta, kind)),
				changes,
				truncated: all.length > changes.length || undefined,
				initial: parent ? undefined : true,
				stats: summarize(all),
			};
			if (ws.rounds && ws.loadedHead === parent) {
				ws.rounds.push(round);
				ws.loadedHead = commit;
			}
			ws.lastCommit = commit;
			ws.lastTree = tree;
			// 不在用户仓库里主动 gc：对象由专用引用保活，仓库维护交还用户
			return round;
		}
	});
}

/** 发 prompt 前调用：把两轮之间用户自己的修改单独记一笔（工作区还没有任何提交时记成基线），没改动不提交 */
export function recordWorkspaceChanges(cwdValue: string, session: string): Promise<GrowthRound | null> {
	return commitRound(cwdValue, { kind: "user", session });
}

// ---------- 读取 ----------

export async function isAvailable(): Promise<boolean> {
	return gitOk();
}

/** 一次 git log 读回链上的 commit（时间正序）；since 给出时只读它之后新增的 */
async function logRounds(ws: WorkspaceState, head: string, since: string | undefined, knownTrees: Map<string, string>): Promise<GrowthRound[]> {
	const r = await shadow(ws, [
		// 根 commit 不展开成「全部新增」；签名 / relative 等用户配置不能混进输出
		"-c", "log.showRoot=false", "-c", "log.showSignature=false", "-c", "diff.relative=false",
		"log", "-z", "--topo-order", "--reverse", "--raw", "--numstat", "-M", "--no-abbrev", "--no-color",
		"--format=%x1e%H%x1f%T%x1f%P%x1f%ct%x1f%B%x1f",
		head, ...(since ? [`^${since}`] : []), "--",
	]);
	const rounds: GrowthRound[] = [];
	for (const c of parseRoundLog(r.stdout.toString("utf8"))) {
		const changes = c.changes.slice(0, MAX_CHANGES_PER_ROUND);
		rounds.push({
			commit: c.commit,
			parent: c.parent,
			tree: c.tree,
			parentTree: (c.parent && knownTrees.get(c.parent)) || ws.emptyTree,
			ts: c.ts,
			...parseRoundMessage(c.message),
			changes,
			truncated: c.changes.length > changes.length || undefined,
			initial: c.parent ? undefined : true,
			stats: summarize(c.changes),
		});
		knownTrees.set(c.commit, c.tree);
	}
	return rounds;
}

/** 整条链（缓存）：链头没变直接用；只追加了新 commit 就增量读；链被改写（理论上不会）整条重读 */
async function loadRounds(ws: WorkspaceState): Promise<GrowthRound[]> {
	const head = await readHead(ws);
	if (!head) {
		ws.rounds = [];
		ws.loadedHead = undefined;
		return ws.rounds;
	}
	if (ws.rounds && ws.loadedHead === head.commit) return ws.rounds;
	const known = ws.rounds && ws.loadedHead ? ws.rounds : null;
	const trees = new Map((known ?? []).map((round) => [round.commit, round.tree]));
	let rounds = await logRounds(ws, head.commit, known ? ws.loadedHead : undefined, trees);
	if (known && rounds.length && rounds[0].parent !== ws.loadedHead) rounds = await logRounds(ws, head.commit, undefined, new Map());
	else if (known) rounds = [...known, ...rounds];
	ws.rounds = rounds;
	ws.loadedHead = head.commit;
	return rounds;
}

function sameSessionName(a: string, b: string): boolean {
	return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** 时间轴：默认只取某个会话的 commit；省略 session 取工作区全部。只读：还没提交过的工作区直接返回空（不创建 .git） */
export async function readRounds(cwdValue: string, session?: string): Promise<GrowthRound[]> {
	const cwd = await fs.realpath(path.resolve(cwdValue)).catch(() => path.resolve(cwdValue));
	const key = workspaceKey(cwd);
	if (!registry.workspaces.has(key)) {
		const gitDir = await resolveGitDirFast(cwd);
		if (!gitDir || !(await refExistsFast(gitDir, `${GROWTH_REF_PREFIX}/${key}`))) return [];
	}
	const ws = await getWorkspace(cwd);
	const rounds = await loadRounds(ws);
	if (!session) return [...rounds];
	const name = sessionName(session);
	return rounds.filter((round) => sameSessionName(round.session, name));
}

/** 某个 tree 的文件清单 */
export async function listTree(cwdValue: string, tree: unknown): Promise<TreeFile[]> {
	const ws = await getWorkspace(cwdValue);
	const hash = assertHash(tree, "tree");
	if (hash === ws.emptyTree) return [];
	const r = await shadow(ws, ["ls-tree", "-r", "-l", "-z", hash]);
	return parseLsTree(r.stdout.toString("utf8"));
}

/** 两个 tree 之间的全部变更 */
export async function changesBetween(cwdValue: string, from: unknown, to: unknown): Promise<GrowthChange[]> {
	const ws = await getWorkspace(cwdValue);
	return diffTreesRaw(ws, assertHash(from, "from"), assertHash(to, "to"));
}

export interface GrowthPatch {
	patch: string;
	binary: boolean;
	truncated: boolean;
}

/** 单文件在两个 tree 之间的 unified diff（整文件上下文，前端自己折叠未改动段） */
export async function filePatch(cwdValue: string, from: unknown, to: unknown, relPath: unknown, renamedFrom?: unknown): Promise<GrowthPatch> {
	const ws = await getWorkspace(cwdValue);
	const rel = assertRelPath(relPath);
	const paths = [rel];
	if (typeof renamedFrom === "string" && renamedFrom) paths.push(assertRelPath(renamedFrom));
	const r = await shadow(ws, ["diff", "-M", "--no-color", "--no-ext-diff", "-U1000000", assertHash(from, "from"), assertHash(to, "to"), "--", ...paths]);
	if (/^Binary files .* differ$/m.test(r.stdout.toString("utf8", 0, Math.min(r.stdout.length, 64 * 1024)))) return { patch: "", binary: true, truncated: false };
	if (r.stdout.length <= MAX_PATCH_BYTES) return { patch: r.stdout.toString("utf8"), binary: false, truncated: false };
	return { patch: r.stdout.subarray(0, MAX_PATCH_BYTES).toString("utf8"), binary: false, truncated: true };
}

export interface GrowthContent {
	content: string;
	binary: boolean;
	truncated: boolean;
	size: number;
}

/** 某个 tree 里单文件的全文 */
export async function fileContent(cwdValue: string, tree: unknown, relPath: unknown): Promise<GrowthContent> {
	const ws = await getWorkspace(cwdValue);
	const rel = assertRelPath(relPath);
	const r = await shadow(ws, ["cat-file", "-p", `${assertHash(tree, "tree")}:${rel}`], { allowFail: true });
	if (r.code !== 0) throw new GrowthError("file not found in this snapshot", "not-found");
	const buf = r.stdout;
	const head = buf.subarray(0, Math.min(buf.length, 8000));
	if (head.includes(0)) return { content: "", binary: true, truncated: false, size: buf.length };
	if (buf.length <= MAX_CONTENT_BYTES) return { content: buf.toString("utf8"), binary: false, truncated: false, size: buf.length };
	return { content: buf.subarray(0, MAX_CONTENT_BYTES).toString("utf8"), binary: false, truncated: true, size: buf.length };
}
