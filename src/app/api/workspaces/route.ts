import { NextResponse } from "next/server";
import {
	addWorkspace,
	archiveSession,
	getRemovedWorkspaces,
	getWorkspaceRegistry,
	pickFolderNative,
	registerCwds,
	removeWorkspace,
	setAlias,
} from "@/lib/workspace-store";
import { encodeSessionId } from "@/lib/pi";
import { BoundaryError, resolveSessionPath, resolveWorkspacePath } from "@/lib/path-security";

export const dynamic = "force-dynamic";

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
			action: "add" | "remove" | "pick" | "rename" | "archiveSession" | "registerCwds";
			path?: string;
			name?: string;
			cwds?: string[];
		};
		if (body.action === "pick") {
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
			const sessionPath = await resolveSessionPath(encodeSessionId(body.path));
			const archivedSessions = await archiveSession(sessionPath);
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
