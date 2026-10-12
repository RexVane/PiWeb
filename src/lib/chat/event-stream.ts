/**
 * 会话事件的长轮询通道（浏览器端）。
 *
 * Cloudflare 快速隧道（远程连接的公网入口）不支持 SSE：流式响应被攒成 128KB 一块才转发，
 * 不满一块的尾巴一直卡着——打开会话等不到完整快照（一直转圈），聊天也不流式。
 * 隧道下改成一次次短请求：服务端把这一批事件发完就结束响应（结束时隧道一定吐干净），
 * 浏览器带着 Last-Event-ID 立刻再来一次，漏掉的事件由服务端从环形缓冲补发。
 * 线上格式仍是 SSE 文本，服务端两种模式共用一套写法。
 */

/** 只有快速隧道需要轮询；局域网、本机、用户自己的反向代理都照旧走 SSE */
export function usesEventPolling(hostname: string): boolean {
	return hostname.toLowerCase().endsWith(".trycloudflare.com");
}

export interface SseFrame {
	id?: string;
	event?: string;
	data: string;
}

/** 解析一段完整的 SSE 文本（只认本项目用到的 id / event / data，注释行跳过） */
export function parseSseText(text: string): SseFrame[] {
	const frames: SseFrame[] = [];
	for (const block of text.split(/\r?\n\r?\n/)) {
		const frame: SseFrame = { data: "" };
		const data: string[] = [];
		for (const line of block.split(/\r?\n/)) {
			if (!line || line.startsWith(":")) continue;
			const colon = line.indexOf(":");
			const field = colon === -1 ? line : line.slice(0, colon);
			let value = colon === -1 ? "" : line.slice(colon + 1);
			if (value.startsWith(" ")) value = value.slice(1);
			if (field === "data") data.push(value);
			else if (field === "id") frame.id = value;
			else if (field === "event") frame.event = value;
		}
		if (!data.length) continue;
		frame.data = data.join("\n");
		frames.push(frame);
	}
	return frames;
}

export interface EventPollHandlers {
	/** 一次请求成功返回（断开后恢复时也会再调） */
	onOpen(): void;
	onMessage(data: string): void;
	/** 一次请求失败；之后按退避自动重试 */
	onError(): void;
}

export interface EventPollOptions {
	fetch?: typeof fetch;
	/** 第 n 次连续失败后等多久再试 */
	backoffMs?: (failures: number) => number;
}

const defaultBackoff = (failures: number) => Math.min(2000 * 2 ** (failures - 1), 30_000);

export function pollEventStream(url: string, handlers: EventPollHandlers, { fetch: fetchImpl = fetch, backoffMs = defaultBackoff }: EventPollOptions = {}): { close(): void } {
	const controller = new AbortController();
	let closed = false;
	let lastEventId: string | undefined;
	let open = false;
	let failures = 0;
	const pollUrl = `${url}${url.includes("?") ? "&" : "?"}poll=1`;

	const sleep = (ms: number) => new Promise<void>((resolve) => {
		const timer = setTimeout(resolve, ms);
		controller.signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
	});

	void (async () => {
		while (!closed) {
			let frames: SseFrame[];
			try {
				const response = await fetchImpl(pollUrl, {
					headers: lastEventId ? { "Last-Event-ID": lastEventId } : {},
					cache: "no-store",
					signal: controller.signal,
				});
				if (!response.ok) throw new Error(`events poll failed (${response.status})`);
				frames = parseSseText(await response.text());
			} catch {
				if (closed) return;
				open = false;
				handlers.onError();
				failures += 1;
				await sleep(backoffMs(failures));
				continue;
			}
			if (closed) return;
			failures = 0;
			if (!open) {
				open = true;
				handlers.onOpen();
			}
			for (const frame of frames) {
				if (closed) return;
				handlers.onMessage(frame.data);
				if (frame.id !== undefined) lastEventId = frame.id;
			}
		}
	})();

	return {
		close() {
			closed = true;
			controller.abort();
		},
	};
}
