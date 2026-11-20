/**
 * growth-service：项目生长 = 每轮一个 git commit。
 *
 * 已有仓库可保存记录，普通目录首次记录时在 PiWeb 数据目录创建独立仓库。
 * 快照范围等于工作区，读取路径不初始化仓库。
 * 每轮结束 = 往 PiWeb 独立暂存区 <gitdir>/piweb/index（GIT_INDEX_FILE 传入）add 全部改动，
 * write-tree + commit-tree，挂到专用引用 refs/piweb/rounds/<key>：不碰 HEAD、不碰用户暂存区、不占分支。
 * 排除规则 <gitdir>/piweb/exclude 只叠加、绝不改写用户的 info/exclude。
 *
 * 元信息全部在 commit 里：标题是本轮提问首行，Piweb-Kind / Session / Prompts / Status 写成 trailers。
 * 时间轴 = 一次 `git log --raw --numstat` 读回（每轮相对上一轮的增删改与行数）；
 * 任意两轮任意文件用 git diff 得行级 patch，cat-file 取任意一轮的全文。
 * 工作区的 .gitignore / info/exclude / 全局 excludesFile 与生成的排除文件都生效；
 * 失败保留已发布的链头，下一次记录从该版本恢复私有暂存区。
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";
import { GROWTH_EXCLUDE_DIRS } from "./growth-tree";
import { utf8Prefix } from "./text-sanitize";
import { decodeFilePreview, type DecodedFilePreview } from "./file-preview";
import { enableGrowthActivity, resolveGrowthAttribution, completeGrowthRun, type GrowthAttribution } from "./growth-activity";
import { gitRecords } from "./git-records";
import { gitEnv } from "./child-process-env";
import { comparable, isPathInside, samePath } from "./path-boundary";
export { beginGrowthRun, finishGrowthRun, completeGrowthRun } from "./growth-activity";
import type { GrowthChange, GrowthRound, GrowthRoundKind, GrowthRoundStatus } from "./types";

/** Larger files retain a metadata entry; their contents never enter the object database. */
export const MAX_FILE_BYTES = 1024 * 1024;
/** 单次 patch 输出上限 */
const MAX_PATCH_BYTES = 4 * 1024 * 1024;
/** 单文件全文预览上限 */
const MAX_CONTENT_BYTES = 256 * 1024;
/** Bound the cost of one index update independently of total workspace size. */
const INDEX_BATCH_PATHS = 512;
const INDEX_BATCH_BYTES = 32 * 1024 * 1024;
/** 每轮最多列多少条变更；更多的由前端按 tree 对再取 */
const MAX_CHANGES_PER_ROUND = 2000;
/** 每轮 commit 链的专用引用前缀：每个工作区一条 refs/piweb/rounds/<key>，多 worktree 互不覆盖 */
const GROWTH_REF_PREFIX = "refs/piweb/rounds";
/** 时间轴读取的记录分隔符（git log --format 里的 %x1e / %x1f） */
const RECORD_SEP = "\x1e";
const FIELD_SEP = "\x1f";

/** 不进快照的目录 / 文件（写进 <gitdir>/piweb/exclude）；工作区自己的 .gitignore 等同样生效 */
export const EXCLUDE_DIRS = GROWTH_EXCLUDE_DIRS;
const EXCLUDE_FILES = [
	".DS_Store", "Thumbs.db", "*.log", ".env", ".env.*", "!.env.example", "*.pem", "*.key", "*.p12", "*.pfx", "id_rsa*", "id_ed25519*",
	".audit-*/", "*.heapsnapshot", "*.cpuprofile", "*.heapprofile", ".eslintcache", "*.tsbuildinfo", "*.tmp",
];
const EXCLUDE_CONTENT = `# PiWeb growth snapshot exclusions (generated, do not edit)\n${[...EXCLUDE_DIRS.map((d) => `${d}/`), ...EXCLUDE_FILES].join("\n")}\n`;

export class GrowthError extends Error {
	constructor(
		message: string,
		public code: "unavailable" | "too-large" | "not-found" | "failed" | "needs-consent" = "failed",
	) {
		super(message);
		this.name = "GrowthError";
	}
}

interface WorkspaceState {
	key: string;
	cwd: string;
	/** 工作区自身或 PiWeb 数据目录下的 git-dir */
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
	/** 本进程的成功提交计数；首次提交也检查 Git 的自动整理阈值，不扫描累计历史。 */
	commitsSinceGc?: number;
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
const workspaceLastUse = new Map<string, number>();
const activeWorkspaceOperations = new Map<string, number>();
const MAX_CACHED_WORKSPACES = 8;

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
	truncated?: boolean;
}

type Env = Record<string, string | undefined>;

const DEFAULT_GIT_TIMEOUT_MS = 30_000;
const HEAVY_GIT_TIMEOUT_MS = 60_000;

function gitSubcommandLabel(args: readonly string[]): string {
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (arg === "-c" || arg === "--git-dir" || arg === "--work-tree") { i += 1; continue; }
		if (!arg.startsWith("-")) return arg;
	}
	return "command";
}

function runGit(
	args: string[],
	opts: { cwd?: string; input?: Buffer | string; maxBuffer?: number; retainMaxBytes?: number; timeoutMs?: number; env?: Env } = {},
): Promise<RunResult> {
	const maxBuffer = opts.maxBuffer ?? 64 * 1024 * 1024;
	const timeoutMs = opts.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
	const cmdLabel = gitSubcommandLabel(args);
	return resolveGitBin().then(
		(gitBin) =>
			new Promise<RunResult>((resolve, reject) => {
				const child = spawn(gitBin, args, {
					cwd: opts.cwd,
					// A6/G3：环境清洗后再补 git 需要的值；GIT_INDEX_FILE 等由 opts.env 显式传，不从父进程继承。
					env: gitChildEnv(opts.env),
					windowsHide: true,
					stdio: ["pipe", "pipe", "pipe"],
				});
				const out: Buffer[] = [];
				const err: Buffer[] = [];
				let size = 0;
				let retained = 0;
				let errorSize = 0;
				let failure: Error | undefined;
				let killTimer: ReturnType<typeof setTimeout> | undefined;
				const timer = setTimeout(() => fail(new GrowthError(`git ${cmdLabel} timed out after ${timeoutMs} ms in ${opts.cwd}`, "failed")), timeoutMs);
				const fail = (error: Error) => {
					if (failure) return;
					failure = error;
					clearTimeout(timer);
					child.kill();
					killTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
				};
				child.stdout.on("data", (chunk: Buffer) => {
					if (failure) return;
					size += chunk.length;
					if (opts.retainMaxBytes !== undefined) {
						if (retained < opts.retainMaxBytes) {
							const part = chunk.subarray(0, opts.retainMaxBytes - retained);
							out.push(part);
							retained += part.length;
						}
						return;
					}
					if (size > maxBuffer) {
						fail(new GrowthError(`git ${cmdLabel} stdout exceeded ${maxBuffer} bytes in ${opts.cwd}`));
						return;
					}
					out.push(chunk);
				});
				child.stderr.on("data", (chunk: Buffer) => {
					if (failure) return;
					errorSize += chunk.length;
					if (errorSize > maxBuffer) { fail(new GrowthError(`git ${cmdLabel} stderr exceeded ${maxBuffer} bytes in ${opts.cwd}`)); return; }
					err.push(chunk);
				});
				child.stdin.on("error", (error) => fail(new GrowthError(`git input failed: ${error.message}`)));
				child.on("error", (error: NodeJS.ErrnoException) => {
					if (error.code === "ENOENT" && opts.cwd && !existsSync(opts.cwd)) fail(new GrowthError("workspace directory not found", "failed"));
					else fail(error.code === "ENOENT" ? new GrowthError("git is not installed", "unavailable") : error);
				});
				child.on("close", (code) => {
					// A retry may use this index as soon as we return. Wait for Git to release its lock.
					clearTimeout(timer);
					clearTimeout(killTimer);
					if (failure) { reject(failure); return; }
					const truncated = opts.retainMaxBytes !== undefined ? size > opts.retainMaxBytes : false;
					resolve({ stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString("utf8"), code: code ?? -1, ...(truncated ? { truncated: true } : {}) });
				});
				if (opts.input !== undefined) child.stdin.end(opts.input);
				else child.stdin.end();
			}),
	);
}

/**
 * git 子进程环境（A6/G3）：`gitEnv` 返回纯 string 映射，spawn 的类型要求 NodeJS.ProcessEnv
 * （Next 把 NODE_ENV 声明成必填）。清洗规则见 child-process-env.ts。
 */
function gitChildEnv(extra: Env = {}): NodeJS.ProcessEnv {
	return gitEnv({ GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C", ...extra }) as NodeJS.ProcessEnv;
}

/**
 * 解析 git 可执行文件：macOS GUI/launchd 启动的进程 PATH 常不含 Homebrew，
 * spawn("git") 会 ENOENT → 生长快照整体误判不可用。PATH 找不到时退回常见安装位置。
 * 只在非 Windows 生效；结果缓存到 registry（成功后不再变）。git-service 也用它。
 */
export async function resolveGitBin(): Promise<string> {
	if (registry.gitBin) return registry.gitBin;
	let bin = "git";
	if (process.platform !== "win32") {
		const candidates = ["/opt/homebrew/bin/git", "/usr/local/bin/git", "/usr/bin/git", "/usr/local/git/bin/git"];
		// A6/G3：探测进程也不继承凭据类变量；PATH 保留，找不到 git 时仍能按 PATH 判定。
		const probeEnv = gitChildEnv();
		const inPath = await new Promise<boolean>((resolve) => {
			const child = spawn("git", ["--version"], { stdio: "ignore", env: probeEnv });
			child.on("error", () => resolve(false));
			child.on("close", (code) => resolve(code === 0));
		});
		if (!inPath) {
			for (const candidate of candidates) {
				const ok = await new Promise<boolean>((resolve) => {
					const child = spawn(candidate, ["--version"], { stdio: "ignore", env: probeEnv });
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

/** git 不可用时短时间缓存否定结果：避免每个会话重复 30s 超时把 UI 拖死 */
const GIT_FAIL_RETRY_MS = 60_000;

async function gitOk(): Promise<boolean> {
	if (registry.gitOk) return registry.gitOk;
	if (registry.gitFailedAt && Date.now() - registry.gitFailedAt < GIT_FAIL_RETRY_MS) return false;
	const check = runGit(["--version"]).then((r) => r.code === 0, () => false);
	registry.gitOk = check;
	// 成功结果一直留着（项目栏每次打开都会问一次，不必每次起一个 git 进程）；失败只短缓存
	void check.then((ok) => {
		if (ok) {
			registry.gitFailedAt = undefined;
			return;
		}
		registry.gitOk = undefined;
		registry.gitFailedAt = Date.now();
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
async function shadow(
	ws: WorkspaceState,
	args: string[],
	opts: { input?: Buffer | string; maxBuffer?: number; retainMaxBytes?: number; timeoutMs?: number; allowFail?: boolean; env?: Env } = {},
): Promise<RunResult> {
	const base = ["--git-dir", ws.gitDir, "--work-tree", ws.cwd, ...BASE_CONFIG];
	const env: Env = { GIT_INDEX_FILE: ws.indexFile, ...opts.env };
	const r = await runGit([...base, ...args], {
		cwd: ws.cwd,
		input: opts.input,
		maxBuffer: opts.maxBuffer,
		retainMaxBytes: opts.retainMaxBytes,
		timeoutMs: opts.timeoutMs,
		env,
	});
	if (r.code !== 0 && !opts.allowFail) {
		throw new GrowthError(`git ${gitSubcommandLabel(args)} failed in ${ws.cwd}: ${r.stderr.trim().split("\n")[0] || `exit ${r.code}`}`);
	}
	return r;
}

async function* shadowRecords(ws: WorkspaceState, args: string[]): AsyncGenerator<string> {
	const full = ["--git-dir", ws.gitDir, "--work-tree", ws.cwd, ...BASE_CONFIG, ...args];
	yield* gitRecords(await resolveGitBin(), full, {
		cwd: ws.cwd, env: gitChildEnv({ GIT_INDEX_FILE: ws.indexFile }), command: gitSubcommandLabel(args),
	});
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
 * 仅查工作区自身的 .git（含 worktree/submodule 的 gitfile）。
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

function growthDataRoot(): string {
	return path.resolve(getAgentDir(), "web-growth");
}

function privateGitDir(cwd: string): string {
	return path.join(growthDataRoot(), createHash("sha256").update(comparable(cwd)).digest("hex"));
}

async function findSnapshotGitDir(cwd: string): Promise<string | null> {
	const privateDir = privateGitDir(cwd);
	// Keep writing to the same store if the user later initializes a project repository.
	// The private piweb directory is created after Git initialization succeeds.
	if ((await snapshotStat(path.join(privateDir, "piweb")))?.isDirectory()) return privateDir;
	const gitDir = await resolveGitDirFast(cwd);
	if (gitDir && (await snapshotStat(path.join(gitDir, "HEAD")))?.isFile()) return gitDir;
	return null;
}

async function initializePrivateGitDir(cwd: string): Promise<string> {
	const root = growthDataRoot();
	const gitDir = privateGitDir(cwd);
	await fs.mkdir(root, { recursive: true, mode: 0o700 });
	const release = await lockfile.lock(gitDir, {
		realpath: false, stale: 60_000, retries: { retries: 40, minTimeout: 50, maxTimeout: 1000 },
	});
	try {
		const existing = await findSnapshotGitDir(cwd);
		if (existing) return existing;
		await fs.mkdir(gitDir, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "EEXIST") throw error;
		});
		const r = await runGit(["init", "--bare", "--quiet", "--template=", gitDir], { cwd: root });
		if (r.code !== 0) throw new GrowthError(`could not initialize PiWeb snapshot storage: ${r.stderr.trim().split("\n")[0] || `exit ${r.code}`}`);
		await fs.mkdir(path.join(gitDir, "piweb"), { mode: 0o700 });
		return gitDir;
	} finally {
		await release();
	}
}

/** 链头的 commit 与 tree；引用不存在返回 null（for-each-ref 对不存在的引用输出空、退出码 0） */
async function readHead(ws: WorkspaceState): Promise<{ commit: string; tree: string; message: string } | null> {
	const r = await shadow(ws, ["for-each-ref", "--format=%(objectname) %(tree)%00%(contents)", "--count=1", ws.ref]);
	const [hashes, message = ""] = r.stdout.toString("utf8").split("\0", 2);
	const [commit = "", tree = ""] = hashes.split(" ");
	return HASH_RE.test(commit) && HASH_RE.test(tree) ? { commit, tree, message } : null;
}

async function createWorkspace(cwd: string, gitDir: string, key: string): Promise<WorkspaceState> {
	if (registry.workspaces.size >= MAX_CACHED_WORKSPACES) {
		const candidates = [...registry.workspaces.keys()].filter((candidate) => candidate !== key && !activeWorkspaceOperations.get(candidate))
			.sort((left, right) => (workspaceLastUse.get(left) ?? 0) - (workspaceLastUse.get(right) ?? 0));
		for (const candidate of candidates) {
			if (registry.workspaces.size < MAX_CACHED_WORKSPACES) break;
			registry.workspaces.delete(candidate); workspaceLastUse.delete(candidate);
		}
	}
	if (!samePath(gitDir, privateGitDir(cwd))) {
		// Verify repository ownership and the worktree root before using an explicit --git-dir.
		const r = await runGit(["rev-parse", "--show-toplevel"], { cwd });
		const root = r.stdout.toString("utf8").replace(/\r?\n$/, "");
		if (r.code !== 0 || !root || !samePath(realpathSafe(root), cwd)) {
			throw new GrowthError(`could not open the workspace's Git repository: ${r.stderr.trim().split("\n")[0] || "unexpected worktree root"}`);
		}
	}
	const piwebDir = path.join(gitDir, "piweb");
	const ws: WorkspaceState = {
		key,
		cwd,
		gitDir,
		indexFile: path.join(piwebDir, "index"),
		excludeFile: path.join(piwebDir, "exclude"),
		ref: `${GROWTH_REF_PREFIX}/${workspaceKey(cwd)}`,
		rounds: null,
		emptyTree: "",
		lock: Promise.resolve(),
	};
	const empty = await shadow(ws, ["hash-object", "-t", "tree", "--stdin"], { input: "" });
	ws.emptyTree = empty.stdout.toString("utf8").trim();
	return ws;
}

async function workspaceState(cwd: string, gitDir: string): Promise<WorkspaceState> {
	const dir = await fs.stat(gitDir);
	// A repository may be moved away and recreated between requests.
	const key = `${comparable(cwd)}\0${comparable(gitDir)}\0${dir.dev}:${dir.ino}:${dir.birthtimeMs}`;
	workspaceLastUse.set(key, Date.now());
	const pending = registry.workspaces.get(key);
	if (pending) return pending;
	const created = createWorkspace(cwd, gitDir, key);
	registry.workspaces.set(key, created);
	void created.catch(() => {
		if (registry.workspaces.get(key) === created) {
			registry.workspaces.delete(key);
			workspaceLastUse.delete(key);
		}
	});
	return created;
}

async function getWorkspace(cwdValue: string, record = false): Promise<WorkspaceState> {
	const cwd = await fs.realpath(path.resolve(cwdValue)).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT" || error.code === "ENOTDIR") throw new GrowthError("workspace directory not found", record ? "failed" : "not-found");
		throw error;
	});
	if (!(await fs.stat(cwd)).isDirectory()) throw new GrowthError("workspace directory not found", record ? "failed" : "not-found");
	if (isPathInside(realpathSafe(growthDataRoot()), cwd)) throw new GrowthError("PiWeb snapshot storage cannot be recorded as a workspace");
	if (record && !(await gitOk())) throw new GrowthError("git is not installed", "unavailable");
	const existing = await findSnapshotGitDir(cwd);
	if (existing) return workspaceState(cwd, existing);
	if (!record) throw new GrowthError("no project snapshots have been recorded", "not-found");
	return workspaceState(cwd, await initializePrivateGitDir(cwd));
}

function withLock<T>(ws: WorkspaceState, fn: () => Promise<T>): Promise<T> {
	activeWorkspaceOperations.set(ws.key, (activeWorkspaceOperations.get(ws.key) ?? 0) + 1);
	const run = ws.lock.then(fn, fn);
	ws.lock = run.then(() => undefined, () => undefined);
	return run.finally(() => {
		const count = (activeWorkspaceOperations.get(ws.key) ?? 1) - 1;
		if (count > 0) activeWorkspaceOperations.set(ws.key, count); else activeWorkspaceOperations.delete(ws.key);
	});
}

async function withSnapshotLock<T>(ws: WorkspaceState, operation: () => Promise<T>): Promise<T> {
	const release = await lockfile.lock(path.join(ws.gitDir, "piweb", "snapshot"), {
		realpath: false, stale: 120_000, update: 15_000,
		retries: { retries: 120, minTimeout: 100, maxTimeout: 1000 },
	});
	try { return await operation(); } finally { await release(); }
}

const HASH_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
function assertHash(value: unknown, what = "hash"): string {
	if (typeof value !== "string" || !HASH_RE.test(value)) throw new GrowthError(`invalid ${what}`, "not-found");
	return value;
}

function assertRelPath(value: unknown): string {
	if (typeof value !== "string" || !value.trim()) throw new GrowthError("missing path", "not-found");
	const rel = (process.platform === "win32" ? value.replace(/\\/g, "/") : value).replace(/^\.\//, "");
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
		const first = t.indexOf("\t");
		const second = t.indexOf("\t", first + 1);
		if (first < 0 || second < 0) continue;
		const a = t.slice(0, first);
		const d = t.slice(first + 1, second);
		const rest = t.slice(second + 1);
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
	contentOmitted?: boolean;
}

/** Parse regular files and PiWeb metadata entries from a tree listing. */
function treeEntry(record: string): TreeFile | undefined {
	const match = /^(\d+) (\w+) ([0-9a-f]+) +(-|\d+)\t([\s\S]+)$/.exec(record);
	if (!match) return;
	if (isOmitted(match[1], match[3])) {
		return { path: match[5], size: Number.parseInt(match[3].slice(OMITTED_PREFIX.length, OMITTED_PREFIX.length + 14), 16), contentOmitted: true };
	}
	if (match[2] === "blob") return { path: match[5], size: match[4] === "-" ? 0 : Number(match[4]) };
}
export function parseLsTree(raw: string): TreeFile[] {
	return raw.split("\0").flatMap((record) => treeEntry(record) ?? []);
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
class RawChanges {
	private entries = new Map<string, GrowthChange>();
	private status = "";
	private paths: string[] = [];
	private numstat?: { add: number; del: number; binary: boolean };
	private twoPaths = false;
	private omitted = false;
	private hasOmittedSide = false;
	get expectsPath() { return this.status !== "" || Boolean(this.numstat); }

	private applyNumbers(file: string, stats: { add: number; del: number; binary: boolean }) {
		const entry = this.entries.get(file);
		if (!entry || entry.contentOmitted || entry.previousContentOmitted) return;
		entry.add = stats.add;
		entry.del = stats.del;
		if (stats.binary) entry.binary = true;
	}

	accept(value: string) {
		if (this.expectsPath) {
			this.paths.push(value);
			if (this.twoPaths && this.paths.length < 2) return;
			if (this.numstat) this.applyNumbers(value, this.numstat);
			else {
				const status = this.status === "T" ? "M" : this.status === "C" ? "A" : this.status;
				if (status === "A" || status === "D" || status === "M" || status === "R") {
					this.entries.set(value, { status, path: value, ...(status === "R" ? { from: this.paths[0] } : {}),
						...(this.omitted ? { contentOmitted: true } : {}), ...(this.hasOmittedSide ? { previousContentOmitted: true } : {}) });
				}
			}
			this.paths = [];
			this.status = "";
			this.numstat = undefined;
			return;
		}
		const token = value.replace(/^\n/, "");
		if (!token) return;
		if (token.startsWith(":")) {
			const [oldMode, newMode, oldId, newId, status] = token.slice(1).split(" ");
			this.status = status[0];
			this.twoPaths = this.status === "R" || this.status === "C";
			this.omitted = isOmitted(newMode, newId);
			this.hasOmittedSide = isOmitted(oldMode, oldId);
			return;
		}
		const first = token.indexOf("\t"), second = token.indexOf("\t", first + 1);
		if (first < 0 || second < 0) return;
		const a = token.slice(0, first), d = token.slice(first + 1, second);
		const stats = { add: Number(a) || 0, del: Number(d) || 0, binary: a === "-" || d === "-" };
		const file = token.slice(second + 1);
		if (file) this.applyNumbers(file, stats);
		else { this.numstat = stats; this.twoPaths = true; }
	}

	sorted() { return [...this.entries.values()].sort((a, b) => a.path.localeCompare(b.path)); }
}

/** Headers occur between NUL records, never in a pending pathname (which may contain control characters). */
class RoundLogParser {
	private header?: Omit<LogCommit, "changes">;
	private changes = new RawChanges();

	accept(token: string): LogCommit | undefined {
		if (!this.changes.expectsPath && token.startsWith(RECORD_SEP)) {
			const prior = this.finish();
			const [commit, tree, parents, seconds, ...message] = token.slice(1, -1).split(FIELD_SEP);
			this.header = { commit, tree, parent: parents?.split(" ")[0] || null, ts: Number(seconds) * 1000, message: message.join(FIELD_SEP) };
			return prior;
		}
		this.changes.accept(token);
	}

	finish(): LogCommit | undefined {
		if (!this.header) return;
		const commit = { ...this.header, changes: this.changes.sorted() };
		this.changes = new RawChanges();
		this.header = undefined;
		return commit;
	}
}

export function parseRoundLog(raw: string): LogCommit[] {
	const parser = new RoundLogParser();
	const commits = raw.split("\0").flatMap((token) => parser.accept(token) ?? []);
	const last = parser.finish();
	if (last) commits.push(last);
	return commits;
}

const ROUND_KINDS: readonly GrowthRoundKind[] = ["round", "user", "baseline"];
const ROUND_STATUSES: readonly GrowthRoundStatus[] = ["done", "aborted", "error"];
/** 没有提问文字（纯图片）或非 pi 轮次时的 commit 标题；读回时还原成空标题，界面用自己的文案 */
const DEFAULT_TITLES: Record<GrowthRoundKind, string> = { round: "piweb: round", user: "piweb: workspace changes", baseline: "piweb: baseline" };

/** commit message → 标题 + Piweb-* trailers */
export function parseRoundMessage(message: string): Pick<GrowthRound, "kind" | "title" | "session" | "promptIds" | "status" | "attribution" | "concurrentSessions" | "roundNumber"> {
	const lines = message.split("\n");
	const trailers = new Map<string, string>();
	for (const line of lines) {
		const m = /^Piweb-([A-Za-z]+):[ \t]*(.*)$/.exec(line.trim());
		if (m) trailers.set(m[1].toLowerCase(), m[2].trim());
	}
	const kind = ROUND_KINDS.find((k) => k === trailers.get("kind")) ?? "round";
	const status = ROUND_STATUSES.find((s) => s === trailers.get("status")) ?? "done";
	const first = (lines[0] ?? "").trim();
	const roundNumber = Number(trailers.get("round"));
	let concurrentSessions: string[] = [];
	try { const parsed = JSON.parse(trailers.get("concurrent") ?? "[]"); if (Array.isArray(parsed)) concurrentSessions = parsed.filter((entry): entry is string => typeof entry === "string").slice(0, 64); } catch { /* Old/invalid trailers cannot assert individual attribution. */ }
	return {
		kind,
		title: kind === "round" && first !== DEFAULT_TITLES.round ? first : "",
		session: trailers.get("session") ?? "",
		promptIds: (trailers.get("prompts") ?? "").split(",").map((id) => id.trim()).filter(Boolean),
		status,
		...(Number.isSafeInteger(roundNumber) && roundNumber > 0 ? { roundNumber } : {}),
		...(trailers.get("attribution") === "shared" ? { attribution: "shared", concurrentSessions } : {}),
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
	if (Number.isSafeInteger(meta.roundNumber) && meta.roundNumber! > 0) lines.push(`Piweb-Round: ${meta.roundNumber}`);
	if (meta.attribution === "shared") {
		lines.push("Piweb-Attribution: shared", `Piweb-Concurrent: ${JSON.stringify((meta.concurrentSessions ?? []).map((session) => cleanLine(sessionName(session))).slice(0, 64))}`);
	}
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
	const changes = new RawChanges();
	if (from !== to) {
		const args = ["diff-tree", "-r", "-M", "--raw", "--numstat", "--no-abbrev", "--ignore-submodules=none", "-z", from, to];
		for await (const token of shadowRecords(ws, args)) changes.accept(token);
	}
	return changes.sorted();
}

// Regular workspace symlinks and submodules have always been excluded. In the private tree,
// a tagged gitlink is an opaque metadata ID: Git never opens or copies oversized contents.
// Include size for listings and mtime for change detection, in either Git object format.
const OMITTED_PREFIX = "70697765624f";
function omittedId(size: number, mtimeMs: number, hashLength: number): string {
	const stamp = createHash("sha256").update(String(mtimeMs)).digest("hex");
	return (OMITTED_PREFIX + size.toString(16).padStart(14, "0") + stamp).slice(0, hashLength);
}
function isOmitted(mode: string, id: string): boolean {
	return mode === "160000" && id.startsWith(OMITTED_PREFIX);
}

async function snapshotStat(file: string) {
	try { return await fs.lstat(file); }
	catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") return null;
		throw error;
	}
}

/** Keep local PiWeb data out of snapshots even when the data directory is inside the workspace. */
function localDataExcludes(cwd: string): string[] {
	const agentDir = realpathSafe(path.resolve(getAgentDir()));
	const dataRoot = realpathSafe(growthDataRoot());
	return [...new Set([agentDir, dataRoot])]
		.filter((dir) => isPathInside(cwd, dir) && !samePath(cwd, dir))
		.map((dir) => {
			const relative = path.relative(cwd, dir).split(path.sep).join("/");
			return `--exclude=/${relative.replace(/[\\*?[\]]/g, "\\$&")}/`;
		});
}

/** All mutations are in the private index. Drain Git's immutable listing in bounded batches. */
async function refreshIndex(ws: WorkspaceState): Promise<void> {
	const exclude = ["--exclude-standard", `--exclude-from=${ws.excludeFile.replace(/\\/g, "/")}`, ...localDataExcludes(ws.cwd)];
	const update = (args: string[], input: string[]) => shadow(ws, ["update-index", ...args], {
		input: input.join("\0") + "\0", timeoutMs: HEAVY_GIT_TIMEOUT_MS,
	});
	// Remove ignored and disappeared entries first, including file-to-directory transitions.
	for (const args of [["-c", "-i", ...exclude], ["--deleted"]]) {
		let batch: string[] = [];
		for await (const rel of shadowRecords(ws, ["ls-files", "-z", ...args])) {
			batch.push(rel);
			if (batch.length === INDEX_BATCH_PATHS) {
				await update(["--force-remove", "-z", "--stdin"], batch);
				batch = [];
			}
		}
		if (batch.length) await update(["--force-remove", "-z", "--stdin"], batch);
	}

	const processBatch = async (paths: string[]) => {
		const directories = new Map<string, Promise<boolean>>();
		const regularDirectory = (rel: string): Promise<boolean> => {
			if (!rel) return Promise.resolve(true);
			const known = directories.get(rel);
			if (known) return known;
			const check = (async () => {
				const parent = path.posix.dirname(rel);
				if (parent !== "." && !(await regularDirectory(parent))) return false;
				return Boolean((await snapshotStat(path.join(ws.cwd, rel)))?.isDirectory());
			})();
			directories.set(rel, check);
			return check;
		};
		const files = await Promise.all(paths.map(async (rel) => {
			const parent = path.posix.dirname(rel);
			const stat = parent === "." || await regularDirectory(parent) ? await snapshotStat(path.join(ws.cwd, rel)) : null;
			return { rel, stat };
		}));
		const removals: string[] = [];
		const omitted: string[] = [];
		let adds: string[] = [];
		let bytes = 0;
		for (const { rel, stat } of files) {
			if (!stat?.isFile()) { removals.push(rel); continue; }
			if (stat.size > MAX_FILE_BYTES) {
				omitted.push(`160000 ${omittedId(stat.size, stat.mtimeMs, ws.emptyTree.length)}\t${rel}`);
			}
		}
		if (removals.length) await update(["--force-remove", "-z", "--stdin"], removals);
		if (omitted.length) await update(["--replace", "-z", "--index-info"], omitted);
		for (const { rel, stat } of files) {
			if (!stat?.isFile() || stat.size > MAX_FILE_BYTES) continue;
			if (bytes + stat.size > INDEX_BATCH_BYTES) {
				await update(["--add", "--remove", "--replace", "-z", "--stdin"], adds);
				adds = [];
				bytes = 0;
			}
			adds.push(rel);
			bytes += stat.size;
		}
		if (adds.length) await update(["--add", "--remove", "--replace", "-z", "--stdin"], adds);
	};
	let paths: string[] = [];
	for await (const rel of shadowRecords(ws, ["ls-files", "-z", "--others", "--modified", ...exclude])) {
		if (!rel || rel.endsWith("/")) continue;
		paths.push(rel);
		if (paths.length === INDEX_BATCH_PATHS) { await processBatch(paths); paths = []; }
	}
	if (paths.length) await processBatch(paths);
}

export interface RoundMeta extends GrowthAttribution {
	/** user 在工作区还没有任何提交时自动记成 baseline */
	kind: GrowthRoundKind;
	/** 会话 JSONL 路径（commit 里只记文件名） */
	session: string;
	/** round：本轮提问首行 */
	title?: string;
	promptIds?: string[];
	roundNumber?: number;
	status?: GrowthRoundStatus;
}

export interface CommitOptions {
	/** 记录开关由调用方读取；明确开启后才能写快照。 */
	allowRecording?: boolean;
	/** 拍完快照、提交之前再问一次：返回 true 就放弃这次提交（返回 null） */
	abortIf?: () => boolean;
}

/** 每个工作区每提交这么多次跑一次 `git gc --auto`（阈值降到 800 个松散对象，及时压缩包文件减盘占；没到阈值时什么也不做） */
const GC_EVERY_COMMITS = 25;

/** 不等、不设超时（大仓库打包可能要很久，中途杀掉白干）；也不占工作区锁，并发由 git 自己的锁处理 */
async function gcInBackground(ws: WorkspaceState): Promise<void> {
	const gitBin = await resolveGitBin();
	const child = spawn(gitBin, ["-c", "gc.auto=800", "--git-dir", ws.gitDir, "gc", "--auto", "--quiet"], {
		cwd: ws.cwd,
		env: gitChildEnv(),
		stdio: "ignore",
		windowsHide: true,
	});
	child.on("error", () => undefined);
	child.unref();
}

/**
 * 提交一个 commit 到 refs/piweb/rounds/<key>（做法等同 git add -A + git commit，但只用 PiWeb 独立暂存区）。
 * pi 的一轮无论有没有改动都提交（空 commit 也算一轮，轮号与对话一一对应）；
 * 用户修改 / 基线只在工作区相对上一个 commit 有变化时提交，否则返回 null。
 */
export async function commitRound(cwdValue: string, meta: RoundMeta, options: CommitOptions = {}): Promise<GrowthRound | null> {
	if (options.allowRecording !== true) throw new GrowthError("growth tracking requires workspace consent", "needs-consent");
	const ws = await getWorkspace(cwdValue, true);
	await fs.mkdir(path.dirname(ws.indexFile), { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
		if (error.code !== "EEXIST") throw error;
	});
	enableGrowthActivity(ws.cwd, ws.gitDir);
	return withLock(ws, () => withSnapshotLock(ws, async () => {
		meta = { ...meta, ...await resolveGrowthAttribution(ws.cwd, meta, meta.session) };
		if (options.abortIf?.()) return null;
		if (ws.excludeRules !== EXCLUDE_CONTENT) {
			await fs.writeFile(ws.excludeFile, EXCLUDE_CONTENT, "utf8");
			ws.excludeRules = EXCLUDE_CONTENT;
		}
		// Recover an interrupted/failed writer (including another process) from the published tree.
		// A matching index keeps its stat cache, so unchanged files need no content reads.
		const head = await readHead(ws);
		ws.lastCommit = head?.commit;
		ws.lastTree = head?.tree;
		// Retrying after publication can happen if the process stopped before acknowledging the turn.
		if (head && meta.kind === "round" && meta.promptIds?.length) {
			const prior = parseRoundMessage(head.message);
			const current = parseRoundMessage(roundMessage(meta, "round"));
			if (prior.kind === "round" && sameSessionName(prior.session, current.session)
				&& prior.promptIds.length > 0 && prior.promptIds[0] === current.promptIds[0]) return null;
		}
		const baseTree = head?.tree ?? ws.emptyTree;
		const indexTree = await shadow(ws, ["write-tree"], { allowFail: true });
		if (indexTree.code !== 0 || indexTree.stdout.toString().trim() !== baseTree) {
			await shadow(ws, ["read-tree", "--reset", baseTree]);
		}
		await refreshIndex(ws);
		const tree = (await shadow(ws, ["write-tree"], { timeoutMs: HEAVY_GIT_TIMEOUT_MS })).stdout.toString("utf8").trim();
		assertHash(tree, "tree");
		// 快照拍到一半时 pi 已经开始改文件：分不清谁改的，宁可不记（改动并入 pi 这一轮）
		if (options.abortIf?.()) return null;
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
			if (ws.rounds && ws.loadedHead === parent) {
				ws.rounds.push(round);
				ws.loadedHead = commit;
			}
			ws.lastCommit = commit;
			ws.lastTree = tree;
			// commit-tree 是底层命令，不会像 git commit 那样顺手 gc --auto：快照对象一直是松散文件、只增不减。
			// 隔一段补一次，没到阈值 git 什么都不做。不带 PiWeb 暂存区：用户自己 index 里的对象照常算可达；
			// PiWeb 暂存区此刻刚整体提交，里面的对象都已挂在专用引用上
			// 重启后的第一次记录也检查阈值，短期会话不会一直跳过整理；不再枚举整条历史。
			ws.commitsSinceGc = (ws.commitsSinceGc ?? GC_EVERY_COMMITS - 1) + 1;
			if (ws.commitsSinceGc >= GC_EVERY_COMMITS) {
				ws.commitsSinceGc = 0;
				void gcInBackground(ws).catch(() => console.warn("[piweb] Could not start automatic project history maintenance"));
			}
			return round;
		}
	})).finally(() => completeGrowthRun(ws.cwd, meta.runId).catch((error) => console.warn("[piweb] Could not finish project recording activity", error)));
}

/** 发 prompt 前调用：把两轮之间用户自己的修改单独记一笔（工作区还没有任何提交时记成基线），没改动不提交 */
export function recordWorkspaceChanges(cwdValue: string, session: string, options: CommitOptions = {}): Promise<GrowthRound | null> {
	return commitRound(cwdValue, { kind: "user", session }, options);
}

// ---------- 读取 ----------

export async function isAvailable(): Promise<boolean> {
	return gitOk();
}

/** 一次 git log 读回链上的 commit（时间正序）；since 给出时只读它之后新增的 */
async function logRounds(ws: WorkspaceState, head: string, since: string | undefined, knownTrees: Map<string, string>): Promise<GrowthRound[]> {
	const tokens = shadowRecords(ws, [
		// 根 commit 不展开成「全部新增」；签名 / relative 等用户配置不能混进输出
		"-c", "log.showRoot=false", "-c", "log.showSignature=false", "-c", "diff.relative=false",
		"log", "-z", "--topo-order", "--reverse", "--raw", "--numstat", "-M", "--no-abbrev", "--no-color", "--ignore-submodules=none",
		"--format=%x1e%H%x1f%T%x1f%P%x1f%ct%x1f%B%x1f",
		head, ...(since ? [`^${since}`] : []), "--",
	]);
	const rounds: GrowthRound[] = [];
	const add = (c: LogCommit) => {
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
	};
	const parser = new RoundLogParser();
	for await (const token of tokens) {
		const commit = parser.accept(token);
		if (commit) add(commit);
	}
	const last = parser.finish();
	if (last) add(last);
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
	if (known && rounds[0]?.parent !== ws.loadedHead) rounds = await logRounds(ws, head.commit, undefined, new Map());
	else if (known) rounds = [...known, ...rounds];
	ws.rounds = rounds;
	ws.loadedHead = head.commit;
	return rounds;
}

function sameSessionName(a: string, b: string): boolean {
	return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export async function hasRecordedSnapshot(cwdValue: string): Promise<boolean> {
	const cwd = realpathSafe(path.resolve(cwdValue));
	const gitDir = await findSnapshotGitDir(cwd);
	if (!gitDir) return false;
	const ws = await workspaceState(cwd, gitDir);
	const r = await shadow(ws, ["for-each-ref", "--format=%(refname)", "--count=1", ws.ref]);
	return r.stdout.toString("utf8").trim() === ws.ref;
}

/** 时间轴：默认只取某个会话的 commit；省略 session 取工作区全部。无快照时返回空。 */
export async function readRounds(cwdValue: string, session?: string): Promise<GrowthRound[]> {
	const cwd = realpathSafe(path.resolve(cwdValue));
	const gitDir = await findSnapshotGitDir(cwd);
	if (!gitDir) return [];
	const ws = await workspaceState(cwd, gitDir);
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
	const files: TreeFile[] = [];
	for await (const record of shadowRecords(ws, ["ls-tree", "-r", "-l", "-z", hash])) {
		const entry = treeEntry(record);
		if (entry) files.push(entry);
	}
	return files;
}

/** 两个 tree 之间的全部变更 */
export async function changesBetween(cwdValue: string, from: unknown, to: unknown): Promise<GrowthChange[]> {
	const ws = await getWorkspace(cwdValue);
	return diffTreesRaw(ws, assertHash(from, "from"), assertHash(to, "to"));
}

export interface GrowthPatch {
	contentOmitted?: boolean;
	patch: string;
	binary: boolean;
	truncated: boolean;
}

async function snapshotEntry(ws: WorkspaceState, tree: string, rel: string): Promise<TreeFile | undefined> {
	const result = await shadow(ws, ["--literal-pathspecs", "ls-tree", "-l", "-z", tree, "--", rel]);
	return parseLsTree(result.stdout.toString("utf8")).find((entry) => entry.path === rel);
}

/** 单文件在两个 tree 之间的 unified diff（整文件上下文，前端自己折叠未改动段） */
export async function filePatch(cwdValue: string, from: unknown, to: unknown, relPath: unknown, renamedFrom?: unknown): Promise<GrowthPatch> {
	const ws = await getWorkspace(cwdValue);
	const rel = assertRelPath(relPath);
	const oldRel = typeof renamedFrom === "string" && renamedFrom ? assertRelPath(renamedFrom) : rel;
	const paths = oldRel === rel ? [rel] : [rel, oldRel];
	const fromTree = assertHash(from, "from"), toTree = assertHash(to, "to");
	const [before, after] = await Promise.all([snapshotEntry(ws, fromTree, oldRel), snapshotEntry(ws, toTree, rel)]);
	if (before?.contentOmitted || after?.contentOmitted) return { patch: "", binary: false, truncated: false, contentOmitted: true };
	const r = await shadow(ws, ["--literal-pathspecs", "diff", "-M", "--no-color", "--no-ext-diff", "-U1000000", fromTree, toTree, "--", ...paths], { retainMaxBytes: MAX_PATCH_BYTES + 4 });
	if (/^Binary files .* differ$/m.test(r.stdout.toString("utf8", 0, Math.min(r.stdout.length, 64 * 1024)))) return { patch: "", binary: true, truncated: false };
	if (!r.truncated && r.stdout.length <= MAX_PATCH_BYTES) return { patch: r.stdout.toString("utf8"), binary: false, truncated: false };
	return { patch: utf8Prefix(r.stdout, MAX_PATCH_BYTES).toString("utf8"), binary: false, truncated: true };
}

export interface GrowthContent extends DecodedFilePreview {
	contentOmitted?: boolean;
	truncated: boolean;
	size: number;
}

/** 某个 tree 里单文件的全文 */
export async function fileContent(cwdValue: string, tree: unknown, relPath: unknown): Promise<GrowthContent> {
	const ws = await getWorkspace(cwdValue);
	const rel = assertRelPath(relPath);
	const hash = assertHash(tree, "tree");
	const entry = await snapshotEntry(ws, hash, rel);
	if (!entry) throw new GrowthError("file not found in this snapshot", "not-found");
	if (entry.contentOmitted) return { content: "", truncated: false, binary: false, size: entry.size, contentOmitted: true };
	const r = await shadow(ws, ["cat-file", "-p", `${hash}:${rel}`], { retainMaxBytes: MAX_CONTENT_BYTES + 4 });
	const truncated = entry.size > MAX_CONTENT_BYTES;
	return { ...decodeFilePreview(r.stdout, MAX_CONTENT_BYTES, truncated), truncated, size: entry.size };
}
