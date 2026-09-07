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

export interface WorkspaceRegistrySnapshot {
	workspaces: string[];
	aliases: Record<string, string>;
	archivedSessions: string[];
	removedWorkspaces: string[];
}

let mutationTail: Promise<void> = Promise.resolve();

async function file(): Promise<string> {
	return path.join(getAgentDir(), "web-workspaces.json");
}

async function readFile(): Promise<WorkspaceFile> {
	try {
		const parsed = JSON.parse(await fs.readFile(await file(), "utf8")) as WorkspaceFile;
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

async function write(data: WorkspaceFile): Promise<void> {
	const target = await file();
	await fs.mkdir(path.dirname(target), { recursive: true });
	await fs.writeFile(target, JSON.stringify(data, null, 2), "utf8");
}

async function read(): Promise<WorkspaceFile> {
	await mutationTail;
	return readFile();
}

async function mutate<T>(change: (data: WorkspaceFile) => Promise<T> | T): Promise<T> {
	const operation = mutationTail.then(async () => change(await readFile()));
	mutationTail = operation.then(() => undefined, () => undefined);
	return operation;
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
	return mutate(async (data) => {
		if (!data.aliases) data.aliases = {};
		if (name.trim()) {
			data.aliases[norm] = name.trim();
		} else {
			delete data.aliases[norm];
		}
		await write(data);
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
	return mutate(async (data) => {
		if (!data.archivedSessions) data.archivedSessions = [];
		if (!data.archivedSessions.some((p) => pathKey(p) === key)) {
			data.archivedSessions.push(norm);
			await write(data);
		}
		return data.archivedSessions;
	});
}

export async function forgetSession(sessionPath: string): Promise<string[]> {
	const norm = path.resolve(sessionPath);
	const key = pathKey(norm);
	return mutate(async (data) => {
		const previous = data.archivedSessions ?? [];
		const next = previous.filter((p) => pathKey(p) !== key);
		if (next.length !== previous.length) {
			data.archivedSessions = next;
			await write(data);
		}
		return next;
	});
}

export async function addWorkspace(dir: string): Promise<{ workspaces: string[]; removedWorkspaces: string[] }> {
	const norm = path.resolve(dir);
	const key = pathKey(norm);
	return mutate(async (data) => {
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
		if (changed) await write(data);
		return { workspaces: data.workspaces, removedWorkspaces: data.removedWorkspaces ?? [] };
	});
}

export async function registerCwds(cwds: string[]): Promise<string[]> {
	return mutate(async (data) => {
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
		if (changed) await write(data);
		return data.workspaces;
	});
}

export async function removeWorkspace(dir: string): Promise<{ workspaces: string[]; removedWorkspaces: string[]; aliases: Record<string, string> }> {
	const norm = path.resolve(dir);
	const key = pathKey(norm);
	return mutate(async (data) => {
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
		await write(data);
		return { workspaces: data.workspaces, removedWorkspaces: data.removedWorkspaces, aliases: data.aliases ?? {} };
	});
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
			let settled = false;
			const finish = (value: string) => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				resolve(value);
			};
			child.on("error", () => finish(""));
			child.on("close", () => finish(buf.trim()));
			// 5 分钟超时保护
			const timeout = setTimeout(() => {
				try {
					child.kill();
				} catch {
					/* ignore */
				}
				finish(buf.trim());
			}, 5 * 60 * 1000);
		});
		return out ? { path: out, canceled: false } : { path: null, canceled: true };
	} finally {
		picking = false;
	}
}
