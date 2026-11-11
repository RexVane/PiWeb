import { NextResponse } from "next/server";
import { getAgentDir } from "@/lib/pi";
import { registerCwds } from "@/lib/workspace-store";
import { IMPORT_SOURCES, type ExternalSessionSummary, type ImportSource } from "@/lib/session-import/types";
import { importSessions, scanAllSources, type ImportSelection } from "@/lib/session-import";
import { importedKey } from "@/lib/session-import/writer";
import { INITIAL_SCAN_LIMIT, MAX_SCAN_LIMIT, MAX_IMPORT_SELECTION } from "@/lib/session-import/limits";

export const dynamic = "force-dynamic";

/** 内部定位信息（文件路径 / 库+行）只用于服务端再扫描，不下发到浏览器 */
function publicSummary(summary: ExternalSessionSummary): Omit<ExternalSessionSummary, "location"> {
	const { location: _location, ...rest } = summary;
	return rest;
}

export async function GET(req: Request) {
	const rawLimit = new URL(req.url).searchParams.get("limit");
	const limit = rawLimit === null ? INITIAL_SCAN_LIMIT : Number(rawLimit);
	if (rawLimit !== null && (!/^\d+$/.test(rawLimit) || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SCAN_LIMIT)) {
		return NextResponse.json({ success: false, error: `limit must be an integer between 1 and ${MAX_SCAN_LIMIT}` }, { status: 400 });
	}
	try {
		const report = await scanAllSources(getAgentDir(), { limit });
		const imported = new Set(report.imported);
		const archived = new Set(report.archived);
		const publicKey = (summary: ExternalSessionSummary) => `${summary.source}:${summary.externalId}`;
		return NextResponse.json({
			success: true,
			data: {
				sessions: report.summaries.map(publicSummary),
				errors: report.errors,
				imported: report.summaries.filter((summary) => imported.has(importedKey(summary.source, summary.externalId))).map(publicKey),
				archived: report.summaries.filter((summary) => archived.has(importedKey(summary.source, summary.externalId))).map(publicKey),
				sources: IMPORT_SOURCES,
				limit,
				hasMore: report.hasMore,
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
	if (sessions.length > MAX_IMPORT_SELECTION) return NextResponse.json({ success: false, error: `too many sessions (max ${MAX_IMPORT_SELECTION})` }, { status: 400 });
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
