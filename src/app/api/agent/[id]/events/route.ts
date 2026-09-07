import { buildSnapshot, getManaged, subscribe, unsubscribe } from "@/lib/agent-manager";
import { BoundaryError, resolveSessionPath } from "@/lib/path-security";

export const dynamic = "force-dynamic";

/** SSE：先推完整快照，再推增量；心跳保活；断线由浏览器 EventSource 自动重连（带 Last-Event-ID） */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	let sessionPath: string;
	try {
		sessionPath = await resolveSessionPath(id);
	} catch (error) {
		return new Response(error instanceof BoundaryError ? error.message : "invalid session", { status: 400 });
	}
	const m = getManaged(sessionPath);
	const rawLastEventId = req.headers.get("last-event-id");
	const parsedLastEventId = rawLastEventId === null ? undefined : Number.parseInt(rawLastEventId, 10);
	const lastEventId = Number.isSafeInteger(parsedLastEventId) && (parsedLastEventId ?? -1) >= 0 ? parsedLastEventId : undefined;

	const encoder = new TextEncoder();
	let closed = false;
	let subscriber: ((seq: number, json: string) => void) | null = null;
	let ping: ReturnType<typeof setInterval> | null = null;

	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			const write = (chunk: string) => {
				if (!closed) controller.enqueue(encoder.encode(chunk));
			};
			subscriber = (seq: number, json: string) => write(`id: ${seq}\ndata: ${json}\n\n`);
			const send = subscriber;

			ping = setInterval(() => write(`: ping\n\n`), 15_000);
			write(`retry: 2000\n\n`);

			req.signal.addEventListener("abort", () => {
				closed = true;
				if (ping) clearInterval(ping);
				unsubscribe(m, send);
				try {
					controller.close();
				} catch {
					/* already closed */
				}
			});

			// 自动重连优先从环形缓冲续放；缓冲断档时才回退到完整快照。
			if (lastEventId !== undefined && subscribe(m, send, lastEventId)) return;
			const snap = await buildSnapshot(m);
			send(snap.seq, JSON.stringify({ type: "snapshot", snapshot: snap, ts: Date.now() }));
			if (!subscribe(m, send, snap.seq)) {
				const latest = await buildSnapshot(m);
				send(latest.seq, JSON.stringify({ type: "snapshot", snapshot: latest, ts: Date.now() }));
				subscribe(m, send, latest.seq);
			}
		},
		cancel() {
			closed = true;
			if (ping) clearInterval(ping);
			if (subscriber) unsubscribe(m, subscriber);
		},
	});

	return new Response(stream, {
		headers: {
			"Content-Type": "text/event-stream; charset=utf-8",
			"Cache-Control": "no-cache, no-transform",
			Connection: "keep-alive",
			"X-Accel-Buffering": "no",
		},
	});
}
