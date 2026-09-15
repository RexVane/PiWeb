import { NextResponse } from "next/server";
import { getAgentDir } from "@/lib/pi";
import { registerCwds } from "@/lib/workspace-store";
import { IMPORT_SOURCES, type ExternalSessionSummary, type ImportSource } from "@/lib/session-import/types";
import { importSessions, scanAllSources, type ImportSelection } from "@/lib/session-import";

export const dynamic = "force-dynamic";

/** 单次导入上限：一次点太多会把内存和磁盘写爆，也让界面报告失去意义 */
const MAX_SELECTION = 500;

/** 内部定位信息（文件路径 / 库+行）只用于服务端再扫描，不下发到浏览器 */
function publicSummary(summary: ExternalSessionSummary): Omit<ExternalSessionSummary, "location"> {
	const { location: _location, ...rest } = summary;
	return rest;
}

export async function GET() {
	try {
		const report = await scanAllSources(getAgentDir());
		return NextResponse.json({
			success: true,
			data: {
				sessions: report.summaries.map(publicSummary),
				errors: report.errors,
				imported: report.imported,
				sources: IMPORT_SOURCES,
			},
		});
	} catch (error) {
		return NextResponse.json({ success: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
	}
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
	const { sessions, fallbackCwd } = body as { sessions?: unknown; fallbackCwd?: unknown };
	if (!Array.isArray(sessions)) return NextResponse.json({ success: false, error: "sessions must be an array" }, { status: 400 });
	if (!sessions.length) return NextResponse.json({ success: false, error: "nothing selected" }, { status: 400 });
	if (sessions.length > MAX_SELECTION) return NextResponse.json({ success: false, error: `too many sessions (max ${MAX_SELECTION})` }, { status: 400 });
	if (fallbackCwd !== undefined && (typeof fallbackCwd !== "string" || fallbackCwd.length > 4096)) {
		return NextResponse.json({ success: false, error: "invalid fallbackCwd" }, { status: 400 });
	}

	// 只接受 {source, externalId}：服务端按来源重新扫描定位，客户端给的路径一律不采信
	const selection: ImportSelection[] = [];
	for (const raw of sessions) {
		if (!raw || typeof raw !== "object") return NextResponse.json({ success: false, error: "invalid selection entry" }, { status: 400 });
		const { source, externalId } = raw as { source?: unknown; externalId?: unknown };
		if (typeof source !== "string" || !IMPORT_SOURCES.includes(source as ImportSource)) {
			return NextResponse.json({ success: false, error: `unknown source: ${String(source)}` }, { status: 400 });
		}
		if (typeof externalId !== "string" || !externalId || externalId.length > 400) {
			return NextResponse.json({ success: false, error: "invalid externalId" }, { status: 400 });
		}
		selection.push({ source: source as ImportSource, externalId });
	}

	try {
		const report = await importSessions(selection, { agentDir: getAgentDir(), fallbackCwd: typeof fallbackCwd === "string" ? fallbackCwd : undefined });
		if (report.workspaces.length) await registerCwds(report.workspaces);
		return NextResponse.json({ success: true, data: report });
	} catch (error) {
		return NextResponse.json({ success: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
	}
}
