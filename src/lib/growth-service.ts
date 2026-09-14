/**
 * growth-service：项目生长快照引擎（影子仓库）。
 *
 * 每个工作区在 ~/.pi/agent/web-growth/<key>/ 下有一个裸 git 仓库（repo/）和一份账本（ledger.jsonl）。
 * 快照 = 以工作区为 work-tree 往影子索引里 update-index，再 write-tree 得到 tree 哈希；
 * 两步之间用 diff-tree 得增删改清单，任意两步任意文件用 git diff 得行级 patch，cat-file 取任意步全文。
 * 每步顺手 commit-tree 到 refs/piweb/growth，让所有快照可达、不会被 gc 清掉。
 * 用户自己的 .git 零改动；非 git 目录同样可用；工作区的 .gitignore 与这里的 info/exclude 都生效。
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { GROWTH_EXCLUDE_DIRS } from "./growth-tree";
import { getAgentDir } from "./pi";
import type { GrowthChange, GrowthStep, GrowthStepKind } from "./types";

/** 单文件快照上限：超过的不进影子仓库（树里也就看不到它） */
export const MAX_FILE_BYTES = 1024 * 1024;
/** 单次 patch 输出上限 */
const MAX_PATCH_BYTES = 4 * 1024 * 1024;
/** 单文件全文预览上限 */
const MAX_CONTENT_BYTES = 256 * 1024;
/** 防止意外把依赖/缓存仓库完整哈希入库，导致工作区长时间卡住。 */
const MAX_CANDIDATES = 50_000;
/** 每步账本里最多记多少条变更；更多的由前端按 tree 对再取 */
const MAX_CHANGES_PER_STEP = 2000;
const GROWTH_REF = "refs/piweb/growth";

/** 不进快照的目录 / 文件（写进影子仓库的 info/exclude）；工作区自己的 .gitignore 同样生效 */
export const EXCLUDE_DIRS = GROWTH_EXCLUDE_DIRS;
const EXCLUDE_FILES = [".DS_Store", "Thumbs.db", "*.log", ".env", ".env.*", "!.env.example", "*.pem", "*.key", "*.p12", "*.pfx", "id_rsa*", "id_ed25519*"];
const EXCLUDED_DIR_SET = new Set(EXCLUDE_DIRS.map((d) => d.toLowerCase()));
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
	dir: string;
	repo: string;
	ledger: string;
	steps: GrowthStep[];
	lastTree?: string;
	lastCommit?: string;
	emptyTree: string;
	excludeRules?: string;
	/** 同一工作区的快照串行执行（共用一个影子索引） */
	lock: Promise<unknown>;
}

interface Registry {
	workspaces: Map<string, Promise<WorkspaceState>>;
	gitOk?: Promise<boolean>;
}
const globalForGrowth = globalThis as typeof globalThis & { __piWebGrowth?: Registry };
const registry: Registry = (globalForGrowth.__piWebGrowth ??= { workspaces: new Map() });

// ---------- 基础工具 ----------

function comparablePath(p: string): string {
	const norm = path.resolve(p).replace(/\\/g, "/");
	return process.platform === "win32" ? norm.toLowerCase() : norm;
}

/** 工作区目录名：路径 slug + 8 位哈希（Windows 大小写不敏感） */
export function workspaceKey(cwd: string): string {
	const cmp = comparablePath(cwd);
	const slug = cmp.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").slice(-48).toLowerCase();
	return `${slug || "root"}-${createHash("sha1").update(cmp).digest("hex").slice(0, 8)}`;
}

/** 目录监听 / 树渲染共用：这条相对路径是否落在排除目录里 */
export function isExcludedRelPath(rel: string): boolean {
	const parts = rel.replace(/\\/g, "/").split("/").filter(Boolean);
	return parts.some((seg) => EXCLUDED_DIR_SET.has(seg.toLowerCase()));
}

function sameSession(a: string, b: string): boolean {
	return comparablePath(a) === comparablePath(b);
}

interface RunResult {
	stdout: Buffer;
	stderr: string;
	code: number;
}

type Env = Record<string, string | undefined>;

function runGit(args: string[], opts: { cwd?: string; input?: Buffer | string; maxBuffer?: number; env?: Env } = {}): Promise<RunResult> {
	const maxBuffer = opts.maxBuffer ?? 64 * 1024 * 1024;
	return new Promise((resolve, reject) => {
		const child = spawn("git", args, {
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
	});
}

async function gitOk(): Promise<boolean> {
	registry.gitOk ??= runGit(["--version"]).then((r) => {
		const ok = r.code === 0;
		if (!ok) registry.gitOk = undefined;
		return ok;
	}, () => {
		registry.gitOk = undefined;
		return false;
	});
	return registry.gitOk;
}

/** 影子仓库命令：固定 git-dir / work-tree，关掉换行转换与路径转义，输出按字节原样 */
async function shadow(ws: WorkspaceState, args: string[], opts: { input?: Buffer | string; maxBuffer?: number; allowFail?: boolean; env?: Env } = {}): Promise<RunResult> {
	const base = [
		"--git-dir", ws.repo,
		"--work-tree", ws.cwd,
		"-c", "core.autocrlf=false",
		"-c", "core.safecrlf=false",
		"-c", "core.quotepath=false",
		"-c", "core.fsmonitor=false",
		"-c", "core.untrackedCache=false",
	];
	const r = await runGit([...base, ...args], { cwd: ws.cwd, input: opts.input, maxBuffer: opts.maxBuffer, env: opts.env });
	if (r.code !== 0 && !opts.allowFail) {
		throw new GrowthError(`git ${args[0]} failed: ${r.stderr.trim().split("\n")[0] || `exit ${r.code}`}`);
	}
	return r;
}

function growthRoot(): string {
	return path.join(getAgentDir(), "web-growth");
}

function parseStep(line: string): GrowthStep | null {
	try {
		const s = JSON.parse(line) as GrowthStep;
		if (typeof s?.tree !== "string" || typeof s.seq !== "number") return null;
		return s;
	} catch {
		return null;
	}
}

async function createWorkspace(cwd: string): Promise<WorkspaceState> {
	if (!(await gitOk())) throw new GrowthError("git is not installed", "unavailable");
	const key = workspaceKey(cwd);
	const dir = path.join(growthRoot(), key);
	const repo = path.join(dir, "repo");
	const ledger = path.join(dir, "ledger.jsonl");
	await fs.mkdir(dir, { recursive: true });
	const initialized = await fs.stat(path.join(repo, "HEAD")).then(() => true, () => false);
	if (!initialized) {
		const r = await runGit(["init", "-q", "--bare", repo]);
		if (r.code !== 0) throw new GrowthError(`git init failed: ${r.stderr.trim()}`);
	}
	await fs.mkdir(path.join(repo, "info"), { recursive: true });
	await fs.writeFile(path.join(repo, "info", "exclude"), EXCLUDE_CONTENT, "utf8");
	await fs.writeFile(path.join(dir, "meta.json"), JSON.stringify({ cwd, key, createdAt: new Date().toISOString() }, null, 2), "utf8");

	const steps: GrowthStep[] = [];
	try {
		for (const line of (await fs.readFile(ledger, "utf8")).split("\n")) {
			if (!line.trim()) continue;
			const s = parseStep(line);
			if (s) steps.push(s);
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const ws: WorkspaceState = { key, cwd, dir, repo, ledger, steps, emptyTree: "", excludeRules: EXCLUDE_CONTENT, lock: Promise.resolve() };
	const last = steps[steps.length - 1];
	ws.lastTree = last?.tree;
	ws.lastCommit = last?.commit;
	const empty = await shadow(ws, ["hash-object", "-t", "tree", "--stdin"], { input: "" });
	ws.emptyTree = empty.stdout.toString("utf8").trim();
	return ws;
}

async function getWorkspace(cwdValue: string): Promise<WorkspaceState> {
	const cwd = await fs.realpath(path.resolve(cwdValue)).catch(() => path.resolve(cwdValue));
	const key = workspaceKey(cwd);
	let pending = registry.workspaces.get(key);
	if (pending) {
		// 影子仓库可能在运行期间被用户清理掉（~/.pi/agent/web-growth/<key>/）：缓存里的状态就指向不存在的 git-dir，
		// 之后每次快照都报 not a git repository。发现 HEAD 不在就丢掉缓存重建（账本也一并从头开始）
		const ws = await pending.catch(() => null);
		const alive = ws ? await fs.stat(path.join(ws.repo, "HEAD")).then(() => true, () => false) : false;
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

function summarize(changes: GrowthChange[]): GrowthStep["stats"] {
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
	const changes = parseNameStatus(names.stdout.toString("utf8"));
	const stats = parseNumstat(nums.stdout.toString("utf8"));
	for (const c of changes) {
		const s = stats.get(c.path);
		if (!s) continue;
		c.add = s.add;
		c.del = s.del;
		if (s.binary) c.binary = true;
	}
	changes.sort((a, b) => a.path.localeCompare(b.path));
	return changes;
}

/** 候选路径 → 更新影子索引；返回本次处理的文件数 */
async function refreshIndex(ws: WorkspaceState): Promise<number> {
	const listed = await shadow(ws, ["ls-files", "-z", "--others", "--modified", "--deleted", "--exclude-standard"]);
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
		// --remove 同时容忍 lstat 后刚被删掉的文件。这些命令始终只操作影子 git-dir。
		await shadow(ws, ["update-index", "--add", "--remove", "--replace", "-z", "--stdin"], { input: `${adds.slice(i, i + INDEX_BATCH).join("\0")}\0` });
	}
	return candidates.length;
}

export interface SnapshotMeta {
	kind: GrowthStepKind;
	label: string;
	session: string;
	toolCallId?: string;
	toolName?: string;
	/** tree 没变也记一步（会话基线用） */
	force?: boolean;
}

/**
 * 给工作区拍一张快照。tree 与上一步相同且未 force 时返回 null（不记步）。
 */
export async function snapshot(cwdValue: string, meta: SnapshotMeta): Promise<GrowthStep | null> {
	const ws = await getWorkspace(cwdValue);
	return withLock(ws, async () => {
		if (ws.excludeRules !== EXCLUDE_CONTENT) {
			await fs.writeFile(path.join(ws.repo, "info", "exclude"), EXCLUDE_CONTENT, "utf8");
			ws.excludeRules = EXCLUDE_CONTENT;
		}
		await refreshIndex(ws);
		const tree = (await shadow(ws, ["write-tree"])).stdout.toString("utf8").trim();
		assertHash(tree, "tree");
		const parent = ws.lastTree ?? ws.emptyTree;
		if (tree === parent && !meta.force) return null;

		const initial = ws.lastTree === undefined;
		// 工作区第一张快照把所有文件都算“新增”，账本里不存这份清单（前端把基线当中性起点）
		const all = initial ? [] : await diffTreesRaw(ws, parent, tree);
		const changes = all.slice(0, MAX_CHANGES_PER_STEP);

		const env = {
			GIT_AUTHOR_NAME: "PiWeb", GIT_AUTHOR_EMAIL: "piweb@localhost",
			GIT_COMMITTER_NAME: "PiWeb", GIT_COMMITTER_EMAIL: "piweb@localhost",
		};
		const commitArgs = ["commit-tree", tree, "-m", `${meta.kind}: ${meta.label || "snapshot"}`];
		if (ws.lastCommit) commitArgs.push("-p", ws.lastCommit);
		const commit = (await shadow(ws, commitArgs, { env })).stdout.toString("utf8").trim();
		await shadow(ws, ["update-ref", GROWTH_REF, commit]);

		const step: GrowthStep = {
			seq: (ws.steps[ws.steps.length - 1]?.seq ?? 0) + 1,
			ts: Date.now(),
			session: meta.session,
			kind: meta.kind,
			label: meta.label.slice(0, 200),
			tree,
			parent,
			commit,
			toolCallId: meta.toolCallId,
			toolName: meta.toolName,
			changes,
			truncated: all.length > changes.length || undefined,
			initial: initial || undefined,
			stats: summarize(all),
		};
		await fs.appendFile(ws.ledger, `${JSON.stringify(step)}\n`, "utf8");
		ws.steps.push(step);
		ws.lastTree = tree;
		ws.lastCommit = commit;
		if (step.seq % 100 === 0) {
			// 维护命令同样串行化，避免与下一张快照同时操作影子仓库。
			void withLock(ws, async () => {
				await shadow(ws, ["gc", "--auto", "-q"], { allowFail: true });
			}).catch(() => undefined);
		}
		return step;
	});
}

// ---------- 读取 ----------

export async function isAvailable(): Promise<boolean> {
	return gitOk();
}

/** 账本里的步：默认只取某个会话的；省略 session 取工作区全部。只读：还没建过影子仓库的工作区直接返回空 */
export async function readSteps(cwdValue: string, session?: string): Promise<GrowthStep[]> {
	const cwd = await fs.realpath(path.resolve(cwdValue)).catch(() => path.resolve(cwdValue));
	const key = workspaceKey(cwd);
	if (!registry.workspaces.has(key)) {
		const exists = await fs.stat(path.join(growthRoot(), key, "ledger.jsonl")).then(() => true, () => false);
		if (!exists) return [];
	}
	const ws = await getWorkspace(cwd);
	if (!session) return [...ws.steps];
	return ws.steps.filter((s) => sameSession(s.session, session));
}

export async function hasSessionSteps(cwdValue: string, session: string): Promise<boolean> {
	const ws = await getWorkspace(cwdValue);
	return ws.steps.some((s) => sameSession(s.session, session));
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
