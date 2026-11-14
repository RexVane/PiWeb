import { NextResponse } from "next/server";
import { getAgentDir } from "@/lib/pi";
import { registerCwds } from "@/lib/workspace-store";
import { IMPORT_SOURCES, type ExternalSessionSummary, type ImportSource } from "@/lib/session-import/types";
import { importSessions, scanAllSources, type ImportOutcome, type ImportReport, type ImportSelection } from "@/lib/session-import";
import { importedKey } from "@/lib/session-import/writer";
import { INITIAL_SCAN_LIMIT, MAX_SCAN_LIMIT, MAX_IMPORT_SELECTION } from "@/lib/session-import/limits";
import { apiError } from "@/lib/api-error";
import { publicDiagnostic } from "@/lib/public-diagnostic";

export const dynamic = "force-dynamic";

/** 内部定位信息（文件路径 / 库+行）只用于服务端再扫描，不下发到浏览器 */
function publicSummary(summary: ExternalSessionSummary): Omit<ExternalSessionSummary, "location"> {
	const { location: _location, ...rest } = summary;
	return rest;
}

function publicOutcome(outcome: ImportOutcome): ImportOutcome {
	return { ...outcome,
		...(outcome.reason ? { reason: publicDiagnostic(outcome.reason, "导入此会话失败，请检查来源数据和文件权限后重试。") } : {}),
		...(outcome.skipped ? { skipped: outcome.skipped.map((reason) => publicDiagnostic(reason, "部分内容无法导入，请检查来源会话。")) } : {}) };
}

function publicReport(report: ImportReport): ImportReport {
	return { ...report, results: report.results.map(publicOutcome) };
}

export async function GET(req: Request) {
	const rawLimit = new URL(req.url).searchParams.get("limit");
	const limit = rawLimit === null ? INITIAL_SCAN_LIMIT : Number(rawLimit);
	if (rawLimit !== null && (!/^\d+$/.test(rawLimit) || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SCAN_LIMIT)) {
		return NextResponse.json({ success: false, error: `limit must be an integer between 1 and ${MAX_SCAN_LIMIT}` }, { status: 400 });
	}
	try {
		const report = await scanAllSources(getAgentDir(), { limit, signal: req.signal });
		const imported = new Set(report.imported);
		const archived = new Set(report.archived);
		const publicKey = (summary: ExternalSessionSummary) => `${summary.source}:${summary.externalId}`;
		return NextResponse.json({
			success: true,
			data: {
				sessions: report.summaries.map(publicSummary),
				errors: report.errors.map((error) => ({ ...error, message: publicDiagnostic(error.message, "扫描此来源失败，请检查来源数据和文件权限后重试。") })),
				imported: report.summaries.filter((summary) => imported.has(importedKey(summary.source, summary.externalId))).map(publicKey),
				archived: report.summaries.filter((summary) => archived.has(importedKey(summary.source, summary.externalId))).map(publicKey),
				sources: IMPORT_SOURCES,
				limit,
				hasMore: report.hasMore,
			},
		});
	} catch (error) {
		return NextResponse.json({ success: false, ...apiError(error, "扫描导入来源失败，请检查文件权限后重试。") }, { status: 500 });
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
	const { sessions } = body as { sessions?: unknown };
	if (!Array.isArray(sessions)) return NextResponse.json({ success: false, error: "sessions must be an array" }, { status: 400 });
	if (!sessions.length) return NextResponse.json({ success: false, error: "nothing selected" }, { status: 400 });
	if (sessions.length > MAX_IMPORT_SELECTION) return NextResponse.json({ success: false, error: `too many sessions (max ${MAX_IMPORT_SELECTION})` }, { status: 400 });

	// 只接受 {source, externalId}：服务端按来源重新扫描定位，客户端给的路径一律不采信
	const selection: ImportSelection[] = [];
	for (const raw of sessions) {
		if (!raw || typeof raw !== "object") return NextResponse.json({ success: false, error: "invalid selection entry" }, { status: 400 });
		const { source, externalId } = raw as { source?: unknown; externalId?: unknown };
		if (typeof source !== "string" || !IMPORT_SOURCES.includes(source as ImportSource)) {
			return NextResponse.json({ success: false, error: "不支持的导入来源。" }, { status: 400 });
		}
		if (typeof externalId !== "string" || !externalId || externalId.length > 400) {
			return NextResponse.json({ success: false, error: "invalid externalId" }, { status: 400 });
		}
		selection.push({ source: source as ImportSource, externalId });
	}

	if (req.headers.get("accept")?.includes("application/x-ndjson")) {
		const disconnected = new AbortController();
		const signal = AbortSignal.any([req.signal, disconnected.signal]);
		const encoder = new TextEncoder();
		const completed: ImportOutcome[] = [];
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				const send = (event: unknown) => {
					if (signal.aborted) return;
					try { controller.enqueue(encoder.encode(JSON.stringify(event) + "\n")); }
					catch { disconnected.abort(); }
				};
				void (async () => {
					try {
						const report = await importSessions(selection, { agentDir: getAgentDir(), signal, onProgress: (done, total, outcome) => {
							const safeOutcome = outcome ? publicOutcome(outcome) : undefined;
							if (safeOutcome) completed.push(safeOutcome);
							send({ type: "progress", done, total, outcome: safeOutcome });
						} });
						if (report.workspaces.length) await registerCwds(report.workspaces, { restoreRemoved: true });
						send({ type: "result", success: true, data: publicReport(report) });
					} catch (error) {
						const failure = apiError(error, "导入中断，请检查来源数据和文件权限后重试；已完成的会话已保留。");
						const message = failure.error;
						const results = [...completed, ...selection.slice(completed.length).map((item) => ({ ...item, status: "failed" as const, reason: message }))];
						send({ type: "error", ...failure });
						send({ type: "result", success: false, data: { imported: results.filter((item) => item.status === "imported").length, restored: results.filter((item) => item.status === "restored").length,
							skipped: results.filter((item) => item.status === "skipped").length, failed: results.filter((item) => item.status === "failed").length, results,
							workspaces: [...new Set(completed.flatMap((item) => item.workspace ? [item.workspace] : []))], warning: message } });
					}
					finally { try { controller.close(); } catch { /* consumer already cancelled */ } }
				})();
			},
			cancel() { disconnected.abort(new Error("导入连接已取消")); },
		});
		return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" } });
	}
	try {
		const report = await importSessions(selection, { agentDir: getAgentDir(), signal: req.signal });
		if (report.workspaces.length) await registerCwds(report.workspaces, { restoreRemoved: true });
		return NextResponse.json({ success: true, data: publicReport(report) });
	} catch (error) {
		return NextResponse.json({ success: false, ...apiError(error, "导入失败，请检查来源数据和文件权限后重试；已完成的会话已保留。") }, { status: 500 });
	}
}
