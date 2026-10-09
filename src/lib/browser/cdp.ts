/**
 * 极简 Chrome DevTools Protocol 客户端。
 * 传输走 --remote-debugging-pipe（浏览器的第 3/4 号管道，消息以 NUL 分隔），不开任何调试端口；
 * 请求按 id 关联响应，事件按方法名分发（扁平 session：消息自带 sessionId）。
 */
import type { Readable, Writable } from "node:stream";

export interface CdpTransport {
	send(message: string): void;
	onMessage(handler: (message: string) => void): void;
	onClose(handler: (reason: string) => void): void;
	close(): void;
}

/** 浏览器子进程的第 3 号（写）/ 第 4 号（读）管道 */
export function pipeTransport(toBrowser: Writable, fromBrowser: Readable): CdpTransport {
	let buffer = "";
	let messageHandler: (message: string) => void = () => {};
	let closeHandler: (reason: string) => void = () => {};
	let closed = false;
	const close = (reason: string) => {
		if (closed) return;
		closed = true;
		closeHandler(reason);
	};
	fromBrowser.setEncoding("utf8");
	fromBrowser.on("data", (chunk: string) => {
		buffer += chunk;
		for (let end = buffer.indexOf("\0"); end >= 0; end = buffer.indexOf("\0")) {
			const message = buffer.slice(0, end);
			buffer = buffer.slice(end + 1);
			if (message) messageHandler(message);
		}
	});
	fromBrowser.on("end", () => close("browser closed the pipe"));
	fromBrowser.on("error", (error) => close(`pipe error: ${error.message}`));
	toBrowser.on("error", (error) => close(`pipe error: ${error.message}`));
	return {
		send: (message) => {
			if (!closed) toBrowser.write(`${message}\0`);
		},
		onMessage: (handler) => { messageHandler = handler; },
		onClose: (handler) => { closeHandler = handler; },
		close: () => {
			toBrowser.end();
			close("closed");
		},
	};
}

class CdpError extends Error {
	constructor(message: string, public readonly method: string) {
		super(`${method}: ${message}`);
		this.name = "CdpError";
	}
}

type EventHandler = (params: any, sessionId?: string) => void;

interface Pending {
	method: string;
	resolve: (value: any) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

export class CdpConnection {
	private nextId = 0;
	private readonly pending = new Map<number, Pending>();
	private readonly handlers = new Map<string, Set<EventHandler>>();
	private closeReason: string | null = null;
	private readonly closeListeners = new Set<(reason: string) => void>();

	constructor(private readonly transport: CdpTransport, private readonly timeoutMs = 30_000) {
		transport.onMessage((raw) => this.dispatch(raw));
		transport.onClose((reason) => this.shutdown(reason));
	}

	get closed(): boolean {
		return this.closeReason !== null;
	}

	send<T = any>(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = this.timeoutMs): Promise<T> {
		if (this.closeReason !== null) return Promise.reject(new CdpError(`connection closed (${this.closeReason})`, method));
		const id = (this.nextId += 1);
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new CdpError(`timed out after ${Math.round(timeoutMs / 1000)}s`, method));
			}, timeoutMs);
			this.pending.set(id, { method, resolve, reject, timer });
			this.transport.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
		});
	}

	/** 订阅事件；返回取消订阅函数 */
	on(method: string, handler: EventHandler): () => void {
		let set = this.handlers.get(method);
		if (!set) {
			set = new Set();
			this.handlers.set(method, set);
		}
		set.add(handler);
		return () => set.delete(handler);
	}

	onClose(listener: (reason: string) => void): () => void {
		this.closeListeners.add(listener);
		return () => this.closeListeners.delete(listener);
	}

	close(): void {
		this.transport.close();
		this.shutdown("closed");
	}

	private dispatch(raw: string): void {
		let message: { id?: number; method?: string; params?: unknown; result?: unknown; error?: { message?: string }; sessionId?: string };
		try {
			message = JSON.parse(raw);
		} catch {
			return;
		}
		if (typeof message.id === "number") {
			const entry = this.pending.get(message.id);
			if (!entry) return;
			this.pending.delete(message.id);
			clearTimeout(entry.timer);
			if (message.error) entry.reject(new CdpError(message.error.message ?? "protocol error", entry.method));
			else entry.resolve(message.result ?? {});
			return;
		}
		if (!message.method) return;
		for (const handler of this.handlers.get(message.method) ?? []) {
			try {
				handler(message.params ?? {}, message.sessionId);
			} catch {
				/* 一个订阅者出错不影响其他订阅者 */
			}
		}
	}

	private shutdown(reason: string): void {
		if (this.closeReason !== null) return;
		this.closeReason = reason;
		for (const [id, entry] of this.pending) {
			clearTimeout(entry.timer);
			entry.reject(new CdpError(`connection closed (${reason})`, entry.method));
			this.pending.delete(id);
		}
		for (const listener of this.closeListeners) listener(reason);
	}
}
