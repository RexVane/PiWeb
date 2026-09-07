import { NextResponse } from "next/server";
import {
	addWorkspace,
	archiveSession,
	getAliases,
	getArchivedSessions,
	getRemovedWorkspaces,
	listAdded,
	pickFolderNative,
	registerCwds,
	removeWorkspace,
	setAlias,
} from "@/lib/workspace-store";
import { resolveWorkspacePath } from "@/lib/path-security";

export const dynamic = "force-dynamic";

export async function GET() {
	try {
		const [workspaces, aliases, archivedSessions, removedWorkspaces] = await Promise.all([
			listAdded(),
			getAliases(),
			getArchivedSessions(),
			getRemovedWorkspaces(),
		]);
		return NextResponse.json({ success: true, data: { workspaces, aliases, archivedSessions, removedWorkspaces } });
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
			// 选完即加入列表
			if (r.path) await addWorkspace(r.path);
			return NextResponse.json({ success: true, data: r });
		}
		if (body.action === "add") {
			if (!body.path) return NextResponse.json({ success: false, error: "missing path" }, { status: 400 });
			return NextResponse.json({ success: true, data: { workspaces: await addWorkspace(await resolveWorkspacePath(body.path)) } });
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
			const archivedSessions = await archiveSession(body.path);
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
		return NextResponse.json({ success: false, error: String(err?.message ?? err) }, { status: 500 });
	}
}
