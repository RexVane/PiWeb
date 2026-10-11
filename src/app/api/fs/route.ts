import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextResponse } from "next/server";
import { BoundaryError } from "@/lib/path-security";

export const dynamic = "force-dynamic";

/**
 * 只读的目录枚举，供应用内的工作区选择器用（手机等远程设备）。
 *
 * 只列目录、不读内容：选择器的产出是一个路径，随后仍由 resolveWorkspacePath 校验
 * （必须绝对路径、必须存在、必须是目录）才写进工作区注册表。
 */

/** 单个目录最多返回多少条，避免在手机上拉一个几万项的目录 */
const MAX_ENTRIES = 2000;

interface FsEntry {
	name: string;
	path: string;
}

async function isDirectory(target: string): Promise<boolean> {
	try {
		return (await fs.stat(target)).isDirectory();
	} catch {
		return false;
	}
}

/** 设备的起点：Windows 逐个探测盘符，macOS 列 /Volumes，其余从主目录与根开始 */
async function listRoots(): Promise<FsEntry[]> {
	const roots: FsEntry[] = [];
	if (process.platform === "win32") {
		for (let code = 65; code <= 90; code += 1) {
			const drive = `${String.fromCharCode(code)}:\\`;
			if (await isDirectory(drive)) roots.push({ name: drive, path: drive });
		}
		return roots;
	}
	if (process.platform === "darwin") {
		const volumes = await fs.readdir("/Volumes", { withFileTypes: true }).catch(() => []);
		for (const entry of volumes) {
			if (entry.isDirectory() || entry.isSymbolicLink()) roots.push({ name: entry.name, path: path.join("/Volumes", entry.name) });
		}
	}
	const home = os.homedir();
	if (await isDirectory(home)) roots.push({ name: home, path: home });
	if (await isDirectory("/")) roots.push({ name: "/", path: "/" });
	return roots;
}

function directoryError(error: unknown): BoundaryError {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	if (code === "ENOENT") return new BoundaryError("目录不存在");
	if (code === "EACCES" || code === "EPERM") return new BoundaryError("没有权限读取此目录");
	if (code === "ENOTDIR") return new BoundaryError("这不是一个目录");
	return new BoundaryError(error instanceof Error ? error.message : String(error));
}

async function listDirectory(target: unknown) {
	if (target !== undefined && (typeof target !== "string" || target.length === 0 || target.length > 4096)) {
		throw new BoundaryError("invalid path");
	}
	const requested = typeof target === "string" ? target : os.homedir();
	if (!path.isAbsolute(requested)) throw new BoundaryError("path must be absolute");
	// realpath 同时做两件事：解析链接，以及确认目录真的存在
	const resolved = await fs.realpath(requested).catch((error: unknown) => {
		throw directoryError(error);
	});
	let stat;
	try {
		stat = await fs.stat(resolved);
	} catch (error) {
		throw directoryError(error);
	}
	if (!stat.isDirectory()) throw new BoundaryError("这不是一个目录");

	const dirents = await fs.readdir(resolved, { withFileTypes: true }).catch((error: unknown) => {
		throw directoryError(error);
	});
	const entries: FsEntry[] = [];
	for (const entry of dirents) {
		// 符号链接也列出来（macOS 的 /Volumes 全是链接）；能否进入由下一次 list 决定
		if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
		entries.push({ name: entry.name, path: path.join(resolved, entry.name) });
	}
	entries.sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" }));
	const parent = path.dirname(resolved);
	return {
		path: resolved,
		parent: parent === resolved ? null : parent,
		entries: entries.slice(0, MAX_ENTRIES),
		truncated: entries.length > MAX_ENTRIES,
	};
}

export async function POST(req: Request) {
	let body: unknown;
	try {
		body = await req.json();
	} catch {
		return NextResponse.json({ success: false, error: "invalid JSON body" }, { status: 400 });
	}
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		return NextResponse.json({ success: false, error: "expected an object body" }, { status: 400 });
	}
	const { action, path: target } = body as { action?: unknown; path?: unknown };
	try {
		if (action === "roots") return NextResponse.json({ success: true, data: { roots: await listRoots() } });
		if (action === "list") return NextResponse.json({ success: true, data: await listDirectory(target) });
		return NextResponse.json({ success: false, error: "unknown action" }, { status: 400 });
	} catch (error) {
		return NextResponse.json(
			{ success: false, error: error instanceof Error ? error.message : String(error) },
			{ status: error instanceof BoundaryError ? 400 : 500 },
		);
	}
}
