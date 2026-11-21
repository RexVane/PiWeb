import { NextResponse } from "next/server";
import {
	addWorkspace,
	archiveSession,
	forgetSession,
	getRemovedWorkspaces,
	getWorkspaceRegistry,
	getWorkspaceRecoveryNotice,
	pickFolderNative,
	pinSession,
	registerCwds,
	removeWorkspace,
	setAlias,
	unpinSession,
} from "@/lib/workspace-store";
import { encodeSessionId } from "@/lib/pi";
import { disposeSessionPath } from "@/lib/agent-manager";
import { BoundaryError, resolveSessionPath, resolveWorkspacePath } from "@/lib/path-security";
import { isLoopbackHostname } from "@/lib/auth";
import { apiError } from "@/lib/api-error";

export const dynamic = "force-dynamic";

/** 工作区别名上限：过长的名字会被原样持久化进 web-workspaces.json，撑大注册表与前端渲染 */
const MAX_WORKSPACE_NAME_LENGTH = 1000;

function json(body: unknown, init: ResponseInit = {}) {
	const headers = new Headers(init.headers);
	headers.set("Cache-Control", "private, no-store");
	return NextResponse.json(body, { ...init, headers });
}

async function mutationResponse(data: Record<string, unknown>) {
	return json({ success: true, data: { ...data, ...await getWorkspaceRecoveryNotice() } });
}

async function archiveMutationResponse() {
	const { archivedSessions, archivedAt, error, errorCode, warning, recovery } = await getWorkspaceRegistry();
	return json({ success: true, data: { archivedSessions, archivedAt,
		...(error ? { error } : {}), ...(errorCode ? { errorCode } : {}),
		...(warning ? { warning } : {}), ...(recovery ? { recovery } : {}),
	} });
}

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
		return json({ success: true, data: await getWorkspaceRegistry() });
	} catch (err: any) {
		return json({ success: false, ...apiError(err, "工作区记录读取失败，请重试。") }, { status: 500 });
	}
}

export async function POST(req: Request) {
	try {
		const body = (await req.json()) as {
			action:
				| "add"
				| "remove"
				| "pick"
				| "pickDirectory"
				| "rename"
				| "archiveSession"
				| "forgetSession"
				| "registerCwds"
				| "pinSession"
				| "unpinSession";
			path?: string;
			name?: string;
			cwds?: string[];
		};
		if (!body || typeof body !== "object" || Array.isArray(body)
			|| (body.path !== undefined && typeof body.path !== "string")
			|| (body.name !== undefined && typeof body.name !== "string")
			|| (body.cwds !== undefined && (!Array.isArray(body.cwds) || body.cwds.some((cwd) => typeof cwd !== "string")))) {
			return json({ success: false, error: "invalid workspace action", errorCode: "VALIDATION_ERROR" }, { status: 400 });
		}
		if (typeof body.name === "string" && body.name.length > MAX_WORKSPACE_NAME_LENGTH) {
			return json({ success: false, error: "workspace name is too long", errorCode: "VALIDATION_ERROR" }, { status: 400 });
		}
		if (body.action === "pick" || body.action === "pickDirectory") {
			if (!isLoopbackRequest(req)) {
				// 远程设备：不弹主机上的对话框，让前端改用应用内目录浏览器。
				return json({ success: true, data: { path: null, canceled: false, remote: true } });
			}
			let r;
			try {
				r = await pickFolderNative(body.action === "pickDirectory" ? "source" : "workspace");
			} catch {
				// 无可用原生对话框或超时：保留在页面里选目录的入口。
				return json({ success: true, data: { path: null, canceled: false, browse: true } });
			}
			if (body.action === "pickDirectory") return json({ success: true, data: r });
			const registry = r.path ? await addWorkspace(await resolveWorkspacePath(r.path)) : null;
			return registry ? mutationResponse({ ...r, ...registry }) : json({ success: true, data: r });
		}
		if (body.action === "add") {
			if (!body.path) return json({ success: false, error: "missing path", errorCode: "VALIDATION_ERROR" }, { status: 400 });
			return mutationResponse(await addWorkspace(await resolveWorkspacePath(body.path)));
		}
		if (body.action === "remove") {
			if (!body.path) return json({ success: false, error: "missing path", errorCode: "VALIDATION_ERROR" }, { status: 400 });
			const r = await removeWorkspace(body.path);
			return mutationResponse(r);
		}
		if (body.action === "rename") {
			if (!body.path) return json({ success: false, error: "missing path", errorCode: "VALIDATION_ERROR" }, { status: 400 });
			const aliases = await setAlias(body.path, body.name ?? "");
			return mutationResponse({ aliases });
		}
		if (body.action === "archiveSession") {
			if (!body.path) return json({ success: false, error: "missing path", errorCode: "VALIDATION_ERROR" }, { status: 400 });
			const sessionPath = await resolveSessionPath(encodeSessionId(body.path), { allowPending: true });
			// 归档即收工：会话随即从工作区消失，不能让它继续在后台跑（看不见却仍消耗 token）。
			// 只影响这一个会话，其它运行中的会话不受影响。
			await disposeSessionPath(sessionPath);
			await archiveSession(sessionPath);
			return await archiveMutationResponse();
		}
		if (body.action === "forgetSession") {
			if (!body.path) return json({ success: false, error: "missing path", errorCode: "VALIDATION_ERROR" }, { status: 400 });
			const sessionPath = await resolveSessionPath(encodeSessionId(body.path), { allowPending: true });
			await forgetSession(sessionPath);
			return await archiveMutationResponse();
		}
		if (body.action === "pinSession") {
			if (!body.path) return json({ success: false, error: "missing path", errorCode: "VALIDATION_ERROR" }, { status: 400 });
			const sessionPath = await resolveSessionPath(encodeSessionId(body.path), { allowPending: true });
			const pinnedSessions = await pinSession(sessionPath);
			return mutationResponse({ pinnedSessions });
		}
		if (body.action === "unpinSession") {
			if (!body.path) return json({ success: false, error: "missing path", errorCode: "VALIDATION_ERROR" }, { status: 400 });
			const sessionPath = await resolveSessionPath(encodeSessionId(body.path), { allowPending: true });
			const pinnedSessions = await unpinSession(sessionPath);
			return mutationResponse({ pinnedSessions });
		}
		if (body.action === "registerCwds") {
			if (!Array.isArray(body.cwds)) return json({ success: false, error: "missing cwds", errorCode: "VALIDATION_ERROR" }, { status: 400 });
			const workspaces = await registerCwds(body.cwds);
			const removedWorkspaces = await getRemovedWorkspaces();
			return mutationResponse({ workspaces, removedWorkspaces });
		}
		return json({ success: false, error: "unknown action", errorCode: "VALIDATION_ERROR" }, { status: 400 });
	} catch (err: any) {
		return json(
			{ success: false, ...apiError(err, "工作区修改失败，请重试。") },
			{ status: err instanceof BoundaryError || err instanceof SyntaxError ? 400 : 500 },
		);
	}
}
