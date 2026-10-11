import { NextResponse } from "next/server";
import {
	addWorkspace,
	archiveSession,
	forgetSession,
	getRemovedWorkspaces,
	getWorkspaceRegistry,
	pickFolderNative,
	registerCwds,
	removeWorkspace,
	setAlias,
} from "@/lib/workspace-store";
import { encodeSessionId } from "@/lib/pi";
import { disposeSessionPath } from "@/lib/agent-manager";
import { BoundaryError, resolveSessionPath, resolveWorkspacePath } from "@/lib/path-security";
import { isLoopbackHostname } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * 请求是否来自本机回环。
 * 原生文件夹对话框只会在运行 PiWeb 的那台机器上弹出，所以对手机/平板这类远程设备
 * 它等于没有反应——那种情况要让客户端改用应用内目录浏览器（/api/fs）。
 */
function isLoopbackRequest(req: Request): boolean {
	const host = req.headers.get("host") ?? new URL(req.url).host;
	const hostname = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0];
	return isLoopbackHostname(hostname);
}

export async function GET() {
	try {
		return NextResponse.json({ success: true, data: await getWorkspaceRegistry() });
	} catch (err: any) {
		return NextResponse.json({ success: false, error: String(err?.message ?? err) }, { status: 500 });
	}
}

export async function POST(req: Request) {
	try {
		const body = (await req.json()) as {
			action: "add" | "remove" | "pick" | "rename" | "archiveSession" | "forgetSession" | "registerCwds";
			path?: string;
			name?: string;
			cwds?: string[];
		};
		if (body.action === "pick") {
			if (!isLoopbackRequest(req)) {
				// 远程设备：不弹主机上的对话框，让前端改用应用内目录浏览器。
				return NextResponse.json({ success: true, data: { path: null, canceled: false, remote: true } });
			}
			const r = await pickFolderNative();
			const registry = r.path ? await addWorkspace(await resolveWorkspacePath(r.path)) : null;
			return NextResponse.json({ success: true, data: { ...r, ...(registry ?? {}) } });
		}
		if (body.action === "add") {
			if (!body.path) return NextResponse.json({ success: false, error: "missing path" }, { status: 400 });
			return NextResponse.json({ success: true, data: await addWorkspace(await resolveWorkspacePath(body.path)) });
		}
		if (body.action === "remove") {
			if (!body.path) return NextResponse.json({ success: false, error: "missing path" }, { status: 400 });
			const r = await removeWorkspace(body.path);
			return NextResponse.json({ success: true, data: r });
		}
		if (body.action === "rename") {
			if (!body.path) return NextResponse.json({ success: false, error: "missing path" }, { status: 400 });
			const aliases = await setAlias(body.path, body.name ?? "");
			return NextResponse.json({ success: true, data: { aliases } });
		}
		if (body.action === "archiveSession") {
			if (!body.path) return NextResponse.json({ success: false, error: "missing path" }, { status: 400 });
			const sessionPath = await resolveSessionPath(encodeSessionId(body.path), { allowPending: true });
			// 归档即收工：会话随即从工作区消失，不能让它继续在后台跑（看不见却仍消耗 token）。
			// 只影响这一个会话，其它运行中的会话不受影响。
			await disposeSessionPath(sessionPath);
			const archivedSessions = await archiveSession(sessionPath);
			return NextResponse.json({ success: true, data: { archivedSessions } });
		}
		if (body.action === "forgetSession") {
			if (!body.path) return NextResponse.json({ success: false, error: "missing path" }, { status: 400 });
			const sessionPath = await resolveSessionPath(encodeSessionId(body.path), { allowPending: true });
			const archivedSessions = await forgetSession(sessionPath);
			return NextResponse.json({ success: true, data: { archivedSessions } });
		}
		if (body.action === "registerCwds") {
			if (!Array.isArray(body.cwds)) return NextResponse.json({ success: false, error: "missing cwds" }, { status: 400 });
			const workspaces = await registerCwds(body.cwds);
			const removedWorkspaces = await getRemovedWorkspaces();
			return NextResponse.json({ success: true, data: { workspaces, removedWorkspaces } });
		}
		return NextResponse.json({ success: false, error: "unknown action" }, { status: 400 });
	} catch (err: any) {
		return NextResponse.json(
			{ success: false, error: String(err?.message ?? err) },
			{ status: err instanceof BoundaryError ? 400 : 500 },
		);
	}
}
