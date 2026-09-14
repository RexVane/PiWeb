/**
 * workspace-store：手动添加的工作区注册表（~/.pi/agent/web-workspaces.json）。
 * 会话 cwd + 手动添加的目录共同构成侧栏「工作区」列表；pi 不受影响（独立文件）。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { APP_ROOT } from "./app-root";
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { getAgentDir } from "./pi";
import { randomUUID } from "node:crypto";
import { withExternalSettingsLock, withSettingsWriteLock } from "./settings-write-lock";

interface WorkspaceFile {
	workspaces: string[];
	aliases?: Record<string, string>;
	archivedSessions?: string[];
	removedWorkspaces?: string[];
}

export interface WorkspaceRegistrySnapshot {
	workspaces: string[];
	aliases: Record<string, string>;
	archivedSessions: string[];
	removedWorkspaces: string[];
}

function file(): string {
	return path.join(getAgentDir(), "web-workspaces.json");
}

async function readFile(target = file()): Promise<WorkspaceFile> {
	try {
		const parsed = JSON.parse(await fs.readFile(target, "utf8")) as WorkspaceFile;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid workspace registry");
		const aliases = Object.fromEntries(
			Object.entries(typeof parsed.aliases === "object" && parsed.aliases !== null ? parsed.aliases : {})
				.filter((entry): entry is [string, string] => typeof entry[1] === "string"),
		);
		return {
			workspaces: Array.isArray(parsed.workspaces) ? parsed.workspaces.filter((w) => typeof w === "string") : [],
			aliases,
			archivedSessions: Array.isArray(parsed.archivedSessions) ? parsed.archivedSessions.filter((s) => typeof s === "string") : [],
			removedWorkspaces: Array.isArray(parsed.removedWorkspaces) ? parsed.removedWorkspaces.filter((s) => typeof s === "string") : [],
		};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	return { workspaces: [], aliases: {}, archivedSessions: [], removedWorkspaces: [] };
}

function pathKey(value: string): string {
	const resolved = path.resolve(value);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

async function write(data: WorkspaceFile, target: string): Promise<void> {
	await fs.mkdir(path.dirname(target), { recursive: true });
	const temporary = `${target}.${randomUUID()}.tmp`;
	try {
		await fs.writeFile(temporary, JSON.stringify(data, null, 2), { encoding: "utf8", flag: "wx", mode: 0o600 });
		await fs.rename(temporary, target);
	} finally {
		await fs.unlink(temporary).catch(() => undefined);
	}
}

async function read(): Promise<WorkspaceFile> {
	const target = file();
	return withSettingsWriteLock(target, () => readFile(target));
}

async function mutate<T>(change: (data: WorkspaceFile, target: string) => Promise<T> | T): Promise<T> {
	const target = file();
	return withSettingsWriteLock(target, () => withExternalSettingsLock(target, async () => change(await readFile(target), target)));
}

export async function listAdded(): Promise<string[]> {
	return (await read()).workspaces;
}

export async function getRemovedWorkspaces(): Promise<string[]> {
	return (await read()).removedWorkspaces ?? [];
}

export async function getAliases(): Promise<Record<string, string>> {
	return (await read()).aliases ?? {};
}

export async function setAlias(dir: string, name: string): Promise<Record<string, string>> {
	const key = pathKey(path.resolve(dir));
	return mutate(async (data, target) => {
		if (!data.aliases) data.aliases = {};
		// 键统一走 pathKey（win32 小写），并清掉历史遗留的大小写变体，避免别名时有时无
		for (const existing of Object.keys(data.aliases)) {
			if (existing !== key && pathKey(existing) === key) delete data.aliases[existing];
		}
		if (name.trim()) {
			data.aliases[key] = name.trim();
		} else {
			delete data.aliases[key];
		}
		await write(data, target);
		return data.aliases;
	});
}

export async function getArchivedSessions(): Promise<string[]> {
	return (await read()).archivedSessions ?? [];
}

export async function getWorkspaceRegistry(): Promise<WorkspaceRegistrySnapshot> {
	const data = await read();
	return {
		workspaces: data.workspaces,
		aliases: data.aliases ?? {},
		archivedSessions: data.archivedSessions ?? [],
		removedWorkspaces: data.removedWorkspaces ?? [],
	};
}

export async function archiveSession(sessionPath: string): Promise<string[]> {
	const norm = path.resolve(sessionPath);
	const key = pathKey(norm);
	return mutate(async (data, target) => {
		if (!data.archivedSessions) data.archivedSessions = [];
		if (!data.archivedSessions.some((p) => pathKey(p) === key)) {
			data.archivedSessions.push(norm);
			await write(data, target);
		}
		return data.archivedSessions;
	});
}

export async function forgetSession(sessionPath: string): Promise<string[]> {
	const norm = path.resolve(sessionPath);
	const key = pathKey(norm);
	return mutate(async (data, target) => {
		const previous = data.archivedSessions ?? [];
		const next = previous.filter((p) => pathKey(p) !== key);
		if (next.length !== previous.length) {
			data.archivedSessions = next;
			await write(data, target);
		}
		return next;
	});
}

export async function addWorkspace(dir: string): Promise<{ workspaces: string[]; removedWorkspaces: string[] }> {
	const norm = path.resolve(dir);
	const key = pathKey(norm);
	return mutate(async (data, target) => {
		let changed = false;
		if (!data.workspaces.some((w) => pathKey(w) === key)) {
			data.workspaces.push(norm);
			changed = true;
		}
		if (data.removedWorkspaces) {
			const next = data.removedWorkspaces.filter((w) => pathKey(w) !== key);
			changed ||= next.length !== data.removedWorkspaces.length;
			data.removedWorkspaces = next;
		}
		if (changed) await write(data, target);
		return { workspaces: data.workspaces, removedWorkspaces: data.removedWorkspaces ?? [] };
	});
}

export async function registerCwds(cwds: string[]): Promise<string[]> {
	return mutate(async (data, target) => {
		let changed = false;
		const removedKeys = new Set((data.removedWorkspaces ?? []).map(pathKey));
		const existingKeys = new Set(data.workspaces.map(pathKey));

		for (const cwd of cwds) {
			if (!cwd || typeof cwd !== "string") continue;
			const norm = path.resolve(cwd);
			const key = pathKey(norm);
			if (!removedKeys.has(key) && !existingKeys.has(key)) {
				data.workspaces.push(norm);
				existingKeys.add(key);
				changed = true;
			}
		}
		if (changed) await write(data, target);
		return data.workspaces;
	});
}

export async function removeWorkspace(dir: string): Promise<{ workspaces: string[]; removedWorkspaces: string[]; aliases: Record<string, string> }> {
	const norm = path.resolve(dir);
	const key = pathKey(norm);
	return mutate(async (data, target) => {
		data.workspaces = data.workspaces.filter((w) => pathKey(w) !== key);
		if (!data.removedWorkspaces) data.removedWorkspaces = [];
		if (!data.removedWorkspaces.some((w) => pathKey(w) === key)) {
			data.removedWorkspaces.push(norm);
		}
		if (data.aliases) {
			for (const k of Object.keys(data.aliases)) {
				if (pathKey(k) === key) delete data.aliases[k];
			}
		}
		await write(data, target);
		return { workspaces: data.workspaces, removedWorkspaces: data.removedWorkspaces, aliases: data.aliases ?? {} };
	});
}

let picking = false;

/** 收集子进程 stdout（utf8）与 stderr 尾部，带超时；退出码非 0 抛错 */
function runDialog(argv: string[], opts: { timeoutMs?: number; windowsHide?: boolean } = {}): Promise<string> {
	const { timeoutMs = 5 * 60 * 1000, windowsHide = false } = opts;
	return new Promise<string>((resolve, reject) => {
		const child = spawn(argv[0], argv.slice(1), { stdio: ["ignore", "pipe", "pipe"], windowsHide });
		const decoder = new StringDecoder("utf8");
		let buf = "";
		let stderr = "";
		let decoderEnded = false;
		child.stdout.on("data", (data: Buffer) => {
			buf += decoder.write(data);
		});
		child.stderr.on("data", (data: Buffer) => { stderr = (stderr + data.toString("utf8")).slice(-1000); });
		let settled = false;
		let timeout: ReturnType<typeof setTimeout>;
		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			if (!decoderEnded) {
				decoderEnded = true;
				buf += decoder.end();
			}
			if (error) reject(error);
			else resolve(buf.trim());
		};
		child.on("error", (error) => finish(error));
		child.on("close", (code) => finish(code === 0 ? undefined : new Error(stderr || `folder picker exited with code ${code}`)));
		timeout = setTimeout(() => {
			try {
				child.kill();
			} catch {
				/* ignore */
			}
			finish(new Error("folder picker timed out"));
		}, timeoutMs);
	});
}

/** osascript 的 POSIX path 输出带前后引号（可能含转义），剥成普通路径 */
function unquoteApplePath(out: string): string {
	const m = out.match(/^alias "?(.*?)"?$/s) ?? out.match(/^(\/.*)$/s);
	return (m ? m[1] : out).trim();
}

/**
 * 弹出系统原生文件夹选择对话框。
 * - Windows：PowerShell 脚本（现代资源管理器风格，屏幕居中）
 * - macOS：osascript choose folder（原生选择框）
 * - Linux：zenity / kdialog（哪个可用用哪个）
 * 都不可用时抛错，前端有手动输入路径的兜底入口。
 */
export async function pickFolderNative(): Promise<{ path: string | null; canceled: boolean }> {
	if (picking) return { path: null, canceled: true };
	picking = true;
	try {
		if (process.platform === "win32") {
			const script = path.join(APP_ROOT, "scripts", "pick-folder.ps1");
			const out = await runDialog(
				["powershell.exe", "-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-File", script, "选择工作区文件夹"],
				{ windowsHide: true },
			);
			return out ? { path: out, canceled: false } : { path: null, canceled: true };
		}
		if (process.platform === "darwin") {
			const out = await runDialog(["osascript", "-e", 'choose folder with prompt "选择工作区文件夹"']);
			const p = unquoteApplePath(out);
			return p ? { path: p, canceled: false } : { path: null, canceled: true };
		}
		// Linux /其他：zenity → kdialog
		for (const argv of [
			["zenity", "--file-selection", "--directory", "--title=选择工作区文件夹"],
			["kdialog", "--getexistingdirectory", `${os.homedir()}`, "--title", "选择工作区文件夹"],
		]) {
			try {
				const out = await runDialog(argv);
				return out ? { path: out, canceled: false } : { path: null, canceled: true };
			} catch (error) {
				// 未安装（ENOENT）→ 试下一个；用户取消的 zenity 退出码 1 但 stdout 可能为空
				if (error instanceof Error && /ENOENT|not found|not recognized/i.test(error.message)) continue;
				if (/exited with code (1|5)$/.test(error instanceof Error ? error.message : String(error))) return { path: null, canceled: true };
				throw error;
			}
		}
		throw new Error("no folder picker available: install zenity or kdialog, or type the path manually");
	} finally {
		picking = false;
	}
}
