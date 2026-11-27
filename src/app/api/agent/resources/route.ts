import { NextResponse } from "next/server";
import { loadWorkspaceResources, primeWorkspaceWatch, subscribeWorkspaceChanges, workspaceChangeVersion } from "@/lib/agent-manager";
import { BoundaryError, resolveWorkspacePath } from "@/lib/path-security";
import { apiError } from "@/lib/api-error";

export const dynamic = "force-dynamic";

const POLL_HOLD_MS = 25_000;
const POLL_BATCH_MS = 50;

function streamWorkspaceChanges(req: Request, cwd: string, poll: boolean): Response {
	const encoder = new TextEncoder();
	const lastEventId = req.headers.get("last-event-id")?.trim();
	let closed = false;
	let unsubscribe: (() => void) | null = null;
	let ping: ReturnType<typeof setInterval> | null = null;
	let pollTimer: ReturnType<typeof setTimeout> | null = null;
	let batchTimer: ReturnType<typeof setTimeout> | null = null;

	const stop = () => {
		closed = true;
		if (ping) clearInterval(ping);
		if (pollTimer) clearTimeout(pollTimer);
		if (batchTimer) clearTimeout(batchTimer);
		unsubscribe?.();
		unsubscribe = null;
	};

	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			const write = (chunk: string) => {
				if (closed) return;
				try {
					controller.enqueue(encoder.encode(chunk));
				} catch {
					close();
				}
			};
			const close = () => {
				if (closed) return;
				stop();
				try { controller.close(); } catch { /* already closed */ }
			};
			const sendEvent = (version: number, type: "ready" | "workspace_changed") => {
				write(`id: ${version}\ndata: ${JSON.stringify({ type, version, ts: Date.now() })}\n\n`);
				if (poll && !batchTimer) batchTimer = setTimeout(close, POLL_BATCH_MS);
			};

			req.signal.addEventListener("abort", close, { once: true });
			try {
				await primeWorkspaceWatch(cwd);
			} catch {
				/* discovery errors still allow watching for subsequent fixes */
			}
			if (closed) return;
			const currentVersion = workspaceChangeVersion(cwd);
			if (!poll) {
				ping = setInterval(() => write(`event: ping\ndata: {"ts":${Date.now()}}\n\n`), 15_000);
				ping.unref?.();
				write(`retry: 2000\n\n`);
				sendEvent(currentVersion, "ready");
			} else {
				pollTimer = setTimeout(close, POLL_HOLD_MS);
				if (lastEventId === undefined) {
					sendEvent(currentVersion, "ready");
					return;
				}
				if (lastEventId !== String(currentVersion)) {
					sendEvent(currentVersion, "workspace_changed");
					return;
				}
			}

			unsubscribe = subscribeWorkspaceChanges(cwd, (version) => {
				sendEvent(version, "workspace_changed");
			});
		},
		cancel() {
			if (!closed) stop();
		},
	});

	return new Response(stream, {
		headers: {
			"Content-Type": poll ? "text/plain; charset=utf-8" : "text/event-stream; charset=utf-8",
			"Cache-Control": poll ? "no-cache" : "no-cache, no-transform",
			Connection: "keep-alive",
			"X-Accel-Buffering": "no",
		},
	});
}

/** 新会话/冷会话的补全数据；不建会话、不启动 MCP。传 stream=1 时实时推送工作区设置与资源变更。 */
export async function GET(req: Request) {
	try {
		const url = new URL(req.url);
		const cwd = await resolveWorkspacePath(url.searchParams.get("cwd"));
		if (url.searchParams.get("stream") === "1") {
			return streamWorkspaceChanges(req, cwd, url.searchParams.get("poll") === "1");
		}
		return NextResponse.json({ success: true, data: await loadWorkspaceResources(cwd) }, { headers: { "Cache-Control": "no-store" } });
	} catch (error) {
		return NextResponse.json(
			{ success: false, ...apiError(error, "工作区技能、插件和提示词读取失败，请检查配置后重试。") },
			{ status: error instanceof BoundaryError ? 400 : 500, headers: { "Cache-Control": "no-store" } },
		);
	}
}
