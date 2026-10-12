/**
 * GitHub 身份：Git 面板头部显示「头像 + 账号」。
 *
 * 只读，不碰任何写操作，也不把 token 交给浏览器。三档降级：
 *
 * 1. `gh api user` —— 本机 gh 已登录时拿到的是**当前登录账号**（最准）；
 * 2. 仓库 `origin` remote 的 owner —— 没装 gh / 没登录也能用，头像是免登录的
 *    `github.com/<owner>.png`；但拿到的可能是「仓库归属者」而不是登录账号；
 * 3. `git config user.name` —— 纯本地身份，没有头像，只作文字兜底。
 *
 * 两条网络路径实测：`gh api user` 约 1.1s、头像约 2.2s，所以结果缓存 12 小时
 * （内存 + 落盘，PiWeb 重启后仍然即时）。头像取到后转成 data URL 随身份一起返回，
 * 前端不用再发第二次请求，断网也能显示。
 *
 * 任何一步失败都只降级，不抛错：Git 面板不该因为 GitHub 不通而少东西。
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { resolveGitBin } from "./growth-service";
import { getAgentDir } from "./pi";

const exec = promisify(execFile);

export interface GithubIdentity {
	login: string;
	/** gh 里的显示名（如「心安」），没有就省略 */
	name?: string;
	/** data URL；取不到头像时省略，UI 退回首字母 */
	avatar?: string;
	source: "gh" | "remote" | "git";
	/** 账号主页，点击可跳转 */
	url?: string;
	/** `owner/repo`（来自 origin remote），没配 remote 就没有 */
	repo?: string;
}

const TTL_MS = 12 * 60 * 60 * 1_000;
const GH_TIMEOUT_MS = 8_000;
const AVATAR_TIMEOUT_MS = 8_000;
const AVATAR_SIZE = 64;
const AVATAR_MAX_BYTES = 256 * 1_024;
const CACHE_FILENAME = "piweb-github-identity.json";
const CACHE_VERSION = 1;

interface CacheFile {
	version: number;
	entries: Record<string, { at: number; value: GithubIdentity | null }>;
}

const memory = new Map<string, { at: number; value: GithubIdentity | null }>();
const inflight = new Map<string, Promise<GithubIdentity | null>>();
let diskLoaded = false;
let diskWrite: Promise<void> | null = null;

function cachePath(): string {
	return path.join(getAgentDir(), CACHE_FILENAME);
}

/** 离线模式（SDK 也认这个变量）：不发任何网络请求，只走本地能算出来的那一档 */
function offline(): boolean {
	const value = process.env.PI_OFFLINE;
	if (!value || value === "0") return false;
	return value.toLowerCase() !== "false";
}

async function loadDisk(): Promise<void> {
	if (diskLoaded) return;
	diskLoaded = true;
	try {
		const raw = JSON.parse(await fs.readFile(cachePath(), "utf8")) as CacheFile;
		if (raw?.version !== CACHE_VERSION || !raw.entries || typeof raw.entries !== "object") return;
		const now = Date.now();
		for (const [key, entry] of Object.entries(raw.entries)) {
			if (!entry || typeof entry.at !== "number" || now - entry.at >= TTL_MS) continue;
			if (!memory.has(key)) memory.set(key, entry);
		}
	} catch {
		/* 没有缓存 / 读不了都当第一次 */
	}
}

function persist(): void {
	if (diskWrite) return;
	diskWrite = (async () => {
		try {
			const entries: CacheFile["entries"] = {};
			for (const [key, entry] of memory) entries[key] = entry;
			await fs.writeFile(cachePath(), JSON.stringify({ version: CACHE_VERSION, entries }), "utf8");
		} catch {
			/* 写不了就只在内存里缓存 */
		} finally {
			diskWrite = null;
		}
	})();
}

/** 解析 gh 可执行文件（PATH 找不到时退回常见安装位置）；结果缓存 */
let ghBin: string | null | undefined;
async function resolveGhBin(): Promise<string | null> {
	if (ghBin !== undefined) return ghBin;
	const candidates = process.platform === "win32"
		? ["gh", path.join(process.env.ProgramFiles ?? "C:\\Program Files", "GitHub CLI", "gh.exe"), path.join(process.env.LOCALAPPDATA ?? "", "Programs", "GitHub CLI", "gh.exe")]
		: ["gh", "/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh"];
	for (const candidate of candidates) {
		if (!candidate) continue;
		const ok = await exec(candidate, ["--version"], { timeout: 5_000, windowsHide: true }).then(() => true, () => false);
		if (ok) {
			ghBin = candidate;
			return ghBin;
		}
	}
	ghBin = null;
	return ghBin;
}

async function git(cwd: string, args: string[]): Promise<string> {
	const out = await exec(await resolveGitBin(), args, {
		cwd,
		timeout: 15_000,
		maxBuffer: 1024 * 1_024,
		windowsHide: true,
		env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
	});
	return out.stdout;
}

/** 从 remote URL 里取 owner 与仓库名：支持 https / ssh / git:// 三种写法 */
export function parseGithubRemote(remote: string | undefined | null): { owner: string; repo?: string } | null {
	if (!remote) return null;
	const trimmed = remote.trim().replace(/\.git$/, "");
	const m = trimmed.match(/github\.com[:/]+([^/]+)(?:\/([^/]+))?/i);
	if (!m?.[1]) return null;
	return { owner: m[1], repo: m[2] ? `${m[1]}/${m[2]}` : undefined };
}

async function ghAccount(cwd: string): Promise<{ login: string; name?: string; url?: string } | null> {
	if (offline()) return null;
	const bin = await resolveGhBin();
	if (!bin) return null;
	try {
		const { stdout } = await exec(bin, ["api", "user"], {
			cwd,
			timeout: GH_TIMEOUT_MS,
			maxBuffer: 1024 * 1_024,
			windowsHide: true,
			env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" },
		});
		const parsed = JSON.parse(stdout) as { login?: unknown; name?: unknown; html_url?: unknown };
		if (typeof parsed.login !== "string" || !parsed.login) return null;
		return {
			login: parsed.login,
			name: typeof parsed.name === "string" && parsed.name.trim() ? parsed.name.trim() : undefined,
			url: typeof parsed.html_url === "string" ? parsed.html_url : undefined,
		};
	} catch {
		// 没网 / 没登录 / token 失效：交给下一档
		return null;
	}
}

async function avatarDataUrl(owner: string): Promise<string | undefined> {
	if (offline()) return undefined;
	try {
		const res = await fetch(`https://github.com/${encodeURIComponent(owner)}.png?size=${AVATAR_SIZE}`, {
			signal: AbortSignal.timeout(AVATAR_TIMEOUT_MS),
			headers: { Accept: "image/*" },
		});
		if (!res.ok) return undefined;
		const type = res.headers.get("content-type") ?? "image/png";
		if (!type.startsWith("image/")) return undefined;
		const buffer = Buffer.from(await res.arrayBuffer());
		if (!buffer.length || buffer.length > AVATAR_MAX_BYTES) return undefined;
		return `data:${type};base64,${buffer.toString("base64")}`;
	} catch {
		return undefined;
	}
}

async function compute(root: string): Promise<GithubIdentity | null> {
	let remote: { owner: string; repo?: string } | null = null;
	try {
		remote = parseGithubRemote(await git(root, ["remote", "get-url", "origin"]));
	} catch {
		/* 没有 origin 就往下走 */
	}
	const account = await ghAccount(root);
	if (account) {
		return {
			login: account.login,
			name: account.name,
			url: account.url ?? `https://github.com/${account.login}`,
			avatar: await avatarDataUrl(account.login),
			source: "gh",
			repo: remote?.repo,
		};
	}
	if (remote) {
		return { login: remote.owner, url: `https://github.com/${remote.owner}`, avatar: await avatarDataUrl(remote.owner), source: "remote", repo: remote.repo };
	}
	try {
		const name = (await git(root, ["config", "user.name"])).trim();
		if (name) return { login: name, source: "git" };
	} catch {
		/* 什么都没配 */
	}
	return null;
}

function start(root: string): Promise<GithubIdentity | null> {
	const existing = inflight.get(root);
	if (existing) return existing;
	const task = compute(root)
		.then((value) => {
			memory.set(root, { at: Date.now(), value });
			persist();
			return value;
		})
		.catch(() => null)
		.finally(() => inflight.delete(root)) as Promise<GithubIdentity | null>;
	inflight.set(root, task);
	return task;
}

/**
 * 取仓库的 GitHub 身份。命中缓存立刻返回；否则**后台**刷新并返回已过期的旧值（或 null），
 * 不会让调用方等网络。要拿首次结果用 `awaitGithubIdentity`。
 */
export function githubIdentity(root: string | null): GithubIdentity | null {
	if (!root) return null;
	void loadDisk();
	const hit = memory.get(root);
	if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
	void start(root);
	return hit?.value ?? null;
}

/** 等首次解析完成（面板刚打开、缓存还冷时用；调用方自己控制超时） */
export async function awaitGithubIdentity(root: string | null): Promise<GithubIdentity | null> {
	if (!root) return null;
	await loadDisk();
	const hit = memory.get(root);
	if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
	return start(root);
}
