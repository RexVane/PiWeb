import { buildSnapshot, getManaged, holdViewer, parseLastEventId, sseEventId, subscribe, unsubscribe } from "@/lib/agent-manager";
import { BoundaryError, resolveSessionPath } from "@/lib/path-security";

export const dynamic = "force-dynamic";

/** 轮询模式：第一条事件写出后再等这么久把同一批凑齐，然后结束响应 */
const POLL_BATCH_MS = 50;
/** 轮询模式：一直没有事件就在这么久后空着结束，浏览器马上再来 */
const POLL_HOLD_MS = 25_000;
/** 轮询模式：两次请求之间仍算有人在看（扩展弹窗不被当成无人值守、会话不被回收） */
const POLL_VIEWER_GRACE_MS = 30_000;

/**
 * SSE：先推完整快照，再推增量；心跳保活；断线由浏览器 EventSource 自动重连（带 Last-Event-ID）。
 * `?poll=1` 是给 Cloudflare 快速隧道用的长轮询（隧道不支持 SSE，见 lib/chat/event-stream）：
 * 同样的帧格式，但发完一批就结束响应，由浏览器带着 Last-Event-ID 再来取下一批。
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const poll = new URL(req.url).searchParams.get("poll") === "1";
	let sessionPath: string;
	try {
		// allowPending：Hero 发首条消息时订阅先于 JSONL 落盘；此时拒绝会让
		// EventSource 收到 400 并永久放弃重连，实时视图永远拿不到快照。
		sessionPath = await resolveSessionPath(id, { allowPending: true });
	} catch (error) {
		return new Response(error instanceof BoundaryError ? error.message : "invalid session", { status: 400 });
	}
	let m: ReturnType<typeof getManaged>;
	try {
		m = getManaged(sessionPath);
	} catch (error) {
		// 待落盘的会话在服务重启后就不存在了：给明确的 404，而不是未捕获异常的 500
		return new Response(error instanceof BoundaryError ? error.message : "session unavailable", { status: error instanceof BoundaryError ? 404 : 500 });
	}
	// id 带着这份会话的 epoch：服务重启或会话被回收重开后，旧的 Last-Event-ID 不会被误续到新一轮事件上
	const lastEventId = parseLastEventId(m, req.headers.get("last-event-id"));

	const encoder = new TextEncoder();
	let closed = false;
	let subscriber: ((seq: number, json: string) => void) | null = null;
	let ping: ReturnType<typeof setInterval> | null = null;
	let pollTimer: ReturnType<typeof setTimeout> | null = null;
	let batchTimer: ReturnType<typeof setTimeout> | null = null;

	const stop = () => {
		closed = true;
		if (ping) clearInterval(ping);
		if (pollTimer) clearTimeout(pollTimer);
		if (batchTimer) clearTimeout(batchTimer);
		if (subscriber) unsubscribe(m, subscriber);
		if (poll) holdViewer(m, POLL_VIEWER_GRACE_MS);
	};

	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			const write = (chunk: string) => {
				if (!closed) controller.enqueue(encoder.encode(chunk));
			};
			const close = () => {
				if (closed) return;
				stop();
				try {
					controller.close();
				} catch {
					/* already closed */
				}
			};
			subscriber = (seq: number, json: string) => {
				write(`id: ${sseEventId(m, seq)}\ndata: ${json}\n\n`);
				if (json.includes('"state":"disposed"')) close();
				else if (poll && !batchTimer) batchTimer = setTimeout(close, POLL_BATCH_MS);
			};
			const send = subscriber;

			if (poll) pollTimer = setTimeout(close, POLL_HOLD_MS);
			else {
				ping = setInterval(() => write(`: ping\n\n`), 15_000);
				write(`retry: 2000\n\n`);
			}

			req.signal.addEventListener("abort", close, { once: true });

			// 自动重连优先从环形缓冲续放；缓冲断档时才回退到完整快照。
			if (lastEventId !== undefined && subscribe(m, send, lastEventId)) return;
			const snap = await buildSnapshot(m);
			if (closed) return;
			send(snap.seq, JSON.stringify({ type: "snapshot", snapshot: snap, ts: Date.now() }));
			// send 里可能已经关了流：这时再订阅就是一个永远不退订的死订阅者，会话也永远回收不掉
			if (closed) return;
			if (!subscribe(m, send, snap.seq)) {
				const latest = await buildSnapshot(m);
				if (closed) return;
				send(latest.seq, JSON.stringify({ type: "snapshot", snapshot: latest, ts: Date.now() }));
				if (!closed) subscribe(m, send, latest.seq);
			}
		},
		cancel() {
			if (!closed) stop();
		},
	});

	return new Response(stream, {
		headers: {
			// 轮询的响应不标成 SSE：隧道对 text/event-stream 另有处理，普通文本响应结束时一定整份送达
			"Content-Type": poll ? "text/plain; charset=utf-8" : "text/event-stream; charset=utf-8",
			// no-transform 让中间代理（Cloudflare 隧道边缘）不再压缩：SSE 必须带（压缩会把流攒住）；
			// 轮询的响应很快就结束，放开让隧道压（实测快照 41 KB → 8.5 KB，流式批次约少九成）。
			// Next 自己不压缩路由处理器的响应，所以本机、局域网不受影响
			"Cache-Control": poll ? "no-cache" : "no-cache, no-transform",
			Connection: "keep-alive",
			"X-Accel-Buffering": "no",
		},
	});
}
