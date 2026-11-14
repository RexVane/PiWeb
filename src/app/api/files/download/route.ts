import { NextResponse } from "next/server";
import { configuredTrustedHosts, isSafeHost, isSafeOrigin } from "@/lib/auth";
import { authEnabled, validSessionCookie } from "@/lib/web-auth";
import { loadSessionRevocations, loadWebSecret } from "@/lib/web-secret";
import { BoundaryError } from "@/lib/path-security";
import { apiError } from "@/lib/api-error";
import { openWorkspaceFile } from "@/lib/files-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const privateHeaders = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };

function byteRange(raw: string | null, size: number): [number, number] | null {
	if (!raw) return [0, size - 1];
	const match = /^bytes=(\d*)-(\d*)$/.exec(raw);
	if (!match || (!match[1] && !match[2]) || size === 0) return null;
	const first = match[1] ? Number(match[1]) : 0;
	const last = match[2] ? Number(match[2]) : size - 1;
	if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last)) return null;
	if (!match[1]) return last > 0 ? [Math.max(0, size - last), size - 1] : null;
	return first < size && first <= last ? [first, Math.min(last, size - 1)] : null;
}

async function serve(req: Request, head = false) {
	const fail = (body: unknown, status: number) => NextResponse.json(body, { status, headers: privateHeaders });
	if (!isSafeHost(req, configuredTrustedHosts()) || !isSafeOrigin(req)) return fail({ success: false, error: "request origin rejected" }, 403);
	let cleanup: (() => Promise<void>) | undefined;
	try {
		const revocations = loadSessionRevocations();
		if (authEnabled() && (revocations.unavailable || !validSessionCookie(req, loadWebSecret(), Date.now(), revocations))) {
			return fail({ success: false, error: "authentication required" }, revocations.unavailable ? 503 : 401);
		}
		const query = new URL(req.url).searchParams;
		const file = await openWorkspaceFile(query.get("cwd"), query.get("path"));
		cleanup = () => file.handle.close();
		const range = byteRange(req.headers.get("range"), file.size);
		if (!range) { await file.handle.close(); return new Response(null, { status: 416, headers: { ...privateHeaders, "Content-Range": `bytes */${file.size}` } }); }
		const [start, end] = range;
		const encodedName = encodeURIComponent(file.name).replace(/[!'()*]/g, (value) => "%" + value.charCodeAt(0).toString(16).toUpperCase());
		const headers = { ...privateHeaders, "Content-Type": "application/octet-stream", "Content-Length": String(Math.max(0, end - start + 1)),
			"Accept-Ranges": "bytes", "Content-Disposition": `attachment; filename="${file.name.replace(/[^\x20-\x7e]|["\\]/g, "_")}"; filename*=UTF-8''${encodedName}`,
			...(req.headers.has("range") ? { "Content-Range": `bytes ${start}-${end}/${file.size}` } : {}),
		};
		const status = req.headers.has("range") ? 206 : 200;
		if (head || file.size === 0) { await file.handle.close(); return new Response(null, { status, headers }); }
		let position = start, closed = false;
		let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
		const close = async () => { if (closed) return; closed = true; req.signal.removeEventListener("abort", abort); await file.handle.close(); };
		const abort = () => { if (!closed) streamController?.error(new Error("download canceled")); void close().catch(() => {}); };
		cleanup = close;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				streamController = controller;
				req.signal.addEventListener("abort", abort, { once: true });
				if (req.signal.aborted) { controller.error(new Error("download canceled")); void close().catch(() => {}); }
			},
			async pull(controller) {
				try {
					if (closed) return;
					const bytes = Buffer.alloc(Math.min(64 * 1024, end - position + 1));
					const read = await file.handle.read(bytes, 0, bytes.length, position);
					if (closed) return;
					if (!read.bytesRead) throw new Error("file changed during download");
					position += read.bytesRead; controller.enqueue(bytes.subarray(0, read.bytesRead));
					if (position > end) { controller.close(); await close(); }
				} catch (error) { if (!closed) controller.error(error); await close(); }
			},
			cancel: close,
		});
		const response = new Response(body, { status, headers });
		cleanup = undefined; // The returned body owns the pinned handle from here.
		return response;
	} catch (error) {
		await cleanup?.().catch(() => {});
		return fail({ success: false, ...apiError(error) }, error instanceof BoundaryError ? 400 : 500);
	}
}

export async function GET(req: Request) { return serve(req); }
export async function HEAD(req: Request) { return serve(req, true); }
