/**
 * workspace-store：手动添加的工作区注册表（~/.pi/agent/web-workspaces.json）。
 * 会话 cwd + 手动添加的目录共同构成侧栏「工作区」列表；pi 不受影响（独立文件）。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { getAgentDir } from "./pi";

interface WorkspaceFile {
	workspaces: string[];
	aliases?: Record<string, string>;
	archivedSessions?: string[];
	removedWorkspaces?: string[];
}

async function file(): Promise<string> {
	return path.join(getAgentDir(), "web-workspaces.json");
}

async function read(): Promise<WorkspaceFile> {
	try {
		const parsed = JSON.parse(await fs.readFile(await file(), "utf8")) as WorkspaceFile;
		return {
			workspaces: Array.isArray(parsed.workspaces) ? parsed.workspaces.filter((w) => typeof w === "string") : [],
			aliases: typeof parsed.aliases === "object" && parsed.aliases !== null ? parsed.aliases : {},
			archivedSessions: Array.isArray(parsed.archivedSessions) ? parsed.archivedSessions.filter((s) => typeof s === "string") : [],
			removedWorkspaces: Array.isArray(parsed.removedWorkspaces) ? parsed.removedWorkspaces.filter((s) => typeof s === "string") : [],
		};
	} catch {
		/* 首次 */
	}
	return { workspaces: [], aliases: {}, archivedSessions: [], removedWorkspaces: [] };
}

async function write(data: WorkspaceFile): Promise<void> {
	await fs.writeFile(await file(), JSON.stringify(data, null, 2), "utf8");
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
	const norm = path.resolve(dir);
	const data = await read();
	if (!data.aliases) data.aliases = {};
	if (name.trim()) {
		data.aliases[norm] = name.trim();
	} else {
		delete data.aliases[norm];
	}
	await write(data);
	return data.aliases;
}

export async function getArchivedSessions(): Promise<string[]> {
	return (await read()).archivedSessions ?? [];
}

export async function archiveSession(sessionPath: string): Promise<string[]> {
	const norm = path.resolve(sessionPath);
	const data = await read();
	if (!data.archivedSessions) data.archivedSessions = [];
	if (!data.archivedSessions.some((p) => path.resolve(p) === norm)) {
		data.archivedSessions.push(norm);
	}
	await write(data);
	return data.archivedSessions;
}

export async function addWorkspace(dir: string): Promise<{ workspaces: string[]; removedWorkspaces: string[] }> {
	const norm = path.resolve(dir);
	const lower = norm.toLowerCase();
	const data = await read();
	if (!data.workspaces.some((w) => path.resolve(w).toLowerCase() === lower)) {
		data.workspaces.push(norm);
	}
	if (data.removedWorkspaces) {
		data.removedWorkspaces = data.removedWorkspaces.filter((w) => path.resolve(w).toLowerCase() !== lower);
	}
	await write(data);
	return { workspaces: data.workspaces, removedWorkspaces: data.removedWorkspaces ?? [] };
}

export async function registerCwds(cwds: string[]): Promise<string[]> {
	const data = await read();
	let changed = false;
	const removedLower = new Set((data.removedWorkspaces ?? []).map((w) => path.resolve(w).toLowerCase()));
	const existingLower = new Set(data.workspaces.map((w) => path.resolve(w).toLowerCase()));

	for (const cwd of cwds) {
		if (!cwd || typeof cwd !== "string") continue;
		const norm = path.resolve(cwd);
		const lower = norm.toLowerCase();
		if (!removedLower.has(lower) && !existingLower.has(lower)) {
			data.workspaces.push(norm);
			existingLower.add(lower);
			changed = true;
		}
	}
	if (changed) {
		await write(data);
	}
	return data.workspaces;
}

export async function removeWorkspace(dir: string): Promise<{ workspaces: string[]; removedWorkspaces: string[]; aliases: Record<string, string> }> {
	const norm = path.resolve(dir);
	const lower = norm.toLowerCase();
	const data = await read();
	data.workspaces = data.workspaces.filter((w) => path.resolve(w).toLowerCase() !== lower);
	if (!data.removedWorkspaces) data.removedWorkspaces = [];
	if (!data.removedWorkspaces.some((w) => path.resolve(w).toLowerCase() === lower)) {
		data.removedWorkspaces.push(norm);
	}
	if (data.aliases) {
		for (const k of Object.keys(data.aliases)) {
			if (path.resolve(k).toLowerCase() === lower) delete data.aliases[k];
		}
	}
	await write(data);
	return { workspaces: data.workspaces, removedWorkspaces: data.removedWorkspaces, aliases: data.aliases ?? {} };
}

let picking = false;

/** 弹出系统原生文件夹选择对话框（Windows 现代资源管理器风格，屏幕居中） */
export async function pickFolderNative(): Promise<{ path: string | null; canceled: boolean }> {
	if (process.platform !== "win32") return { path: null, canceled: true };
	if (picking) return { path: null, canceled: true };
	picking = true;
	try {
		const script = path.join(process.cwd(), "scripts", "pick-folder.ps1");
		const out = await new Promise<string>((resolve) => {
			const child = spawn(
				"powershell.exe",
				["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-File", script, "选择工作区文件夹"],
				{ stdio: ["ignore", "pipe", "pipe"] },
			);
			let buf = "";
			child.stdout.on("data", (d) => (buf += d.toString()));
			child.on("error", () => resolve(""));
			child.on("close", () => resolve(buf.trim()));
			// 5 分钟超时保护
			setTimeout(() => {
				try {
					child.kill();
				} catch {
					/* ignore */
				}
				resolve(buf.trim());
			}, 5 * 60 * 1000);
		});
		return out ? { path: out, canceled: false } : { path: null, canceled: true };
	} finally {
		picking = false;
	}
}
