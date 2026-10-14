"use client";

import { isSideChatId, isSideChatModel, type SideChatModel, type SideChatHistoryMessage, type SideChatProgress, type SideChatRequest, type SideChatUsage } from "@/lib/side-chat/types";

import { requestHistory } from "./request-history";

export interface SideChatMessage {
	id: string;
	role: "user" | "assistant";
	text: string;
	status?: "pending" | "done" | "error" | "aborted";
	error?: string;
	contextTruncated?: boolean;
	lengthLimited?: boolean;
}
export interface SideChatThread {
	id: string;
	title: string;
	messages: SideChatMessage[];
	draft: string;
	model?: SideChatModel;
	request?: { id: string; revision: number };
	/** 最近一次回答的真实用量与窗口：面板右下角的上下文环用它 */
	usage?: SideChatUsage;
	contextWindow?: number;
	/** 这次上下文的真实字符分项（系统提示词 / 引用的主会话背景） */
	characters?: { systemPrompt: number; background: number; systemTools?: number };
	activeTool?: string | null;
	connectionLost?: boolean;
}
export interface SideChatState {
	currentThreadId: string;
	threads: SideChatThread[];
	storageFailed: boolean;
}
export const EMPTY_SIDE_CHAT: SideChatState = { currentThreadId: "", threads: [], storageFailed: false };
const PREFIX = "piweb.sidechat.v1.";

class ApiError extends Error {
	constructor(message: string, readonly status: number) { super(message); }
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
		const timer = setTimeout(finish, ms);
		signal.addEventListener("abort", finish, { once: true });
		if (signal.aborted) finish();
	});
}

/** Browser-owned threads outlive panel unmounts. Only their own subscribers render on an answer update. */
export class SideChatStore {
	private states = new Map<string, SideChatState>();
	private listeners = new Map<string, Set<() => void>>();
	private requests = new Map<string, AbortController>();
	private saves = new Map<string, ReturnType<typeof setTimeout>>();
	constructor(private options: { fetch: typeof fetch; storage: () => Storage; id: () => string } = {
		fetch: (...args) => fetch(...args), storage: () => localStorage, id: () => crypto.randomUUID(),
	}) {}

	get = (sessionId: string | null): SideChatState => {
		if (!sessionId) return EMPTY_SIDE_CHAT;
		let state = this.states.get(sessionId);
		if (state) return state;
		try {
			const raw = this.options.storage().getItem(PREFIX + sessionId);
			if (raw) {
				const saved = JSON.parse(raw) as SideChatState;
				if (isSideChatId(saved.currentThreadId) && Array.isArray(saved.threads) && saved.threads.length && saved.threads.every((thread) =>
					isSideChatId(thread.id) && typeof thread.title === "string" && typeof thread.draft === "string" && Array.isArray(thread.messages) && thread.messages.every((message) =>
						isSideChatId(message.id) && (message.role === "user" || message.role === "assistant") && typeof message.text === "string") &&
					(!thread.request || (isSideChatId(thread.request.id) && Number.isSafeInteger(thread.request.revision)))) && saved.threads.some((thread) => thread.id === saved.currentThreadId)) {
					state = { ...saved, storageFailed: false, threads: saved.threads.map((thread) => ({ ...thread, model: isSideChatModel(thread.model) ? thread.model : undefined })) };
				}
			}
		} catch { /* A unavailable or full browser store must not disable questions. */ }
		if (!state) {
			const thread = this.newThread();
			state = { currentThreadId: thread.id, threads: [thread], storageFailed: false };
		}
		this.states.set(sessionId, state);
		return state;
	};

	flush = (): void => { for (const sessionId of this.states.keys()) this.save(sessionId); };

	subscribe = (sessionId: string | null, listener: () => void): (() => void) => {
		if (!sessionId) return () => {};
		const listeners = this.listeners.get(sessionId) ?? new Set();
		listeners.add(listener);
		this.listeners.set(sessionId, listeners);
		queueMicrotask(() => {
			for (const thread of this.get(sessionId).threads) {
				if (thread.request && !this.requests.has(thread.request.id)) void this.run(sessionId, thread.id, thread.request.id);
			}
		});
		return () => { listeners.delete(listener); };
	};

	private newThread(model?: SideChatModel): SideChatThread { return { id: this.options.id(), title: "", messages: [], draft: "", ...(model ? { model: { ...model } } : {}) }; }
	private notify(sessionId: string): void { for (const listener of this.listeners.get(sessionId) ?? []) listener(); }
	private save(sessionId: string): void {
		const timer = this.saves.get(sessionId);
		if (timer) clearTimeout(timer);
		this.saves.delete(sessionId);
		const state = this.get(sessionId);
		let failed = false;
		try { this.options.storage().setItem(PREFIX + sessionId, JSON.stringify(state)); }
		catch { failed = true; }
		if (state.storageFailed !== failed) {
			this.states.set(sessionId, { ...state, storageFailed: failed });
			this.notify(sessionId);
		}
	}
	private update(sessionId: string, state: SideChatState, immediately = false): void {
		this.states.set(sessionId, state);
		this.notify(sessionId);
		if (immediately) this.save(sessionId);
		else if (!this.saves.has(sessionId)) this.saves.set(sessionId, setTimeout(() => this.save(sessionId), 300));
	}
	private updateThread(sessionId: string, threadId: string, change: (thread: SideChatThread) => SideChatThread, immediately = false): void {
		const state = this.get(sessionId);
		this.update(sessionId, { ...state, threads: state.threads.map((thread) => thread.id === threadId ? change(thread) : thread) }, immediately);
	}

	setDraft(sessionId: string, text: string): void {
		this.updateThread(sessionId, this.get(sessionId).currentThreadId, (thread) => ({ ...thread, draft: text }));
	}
	setModel(sessionId: string, model?: SideChatModel): void {
		this.updateThread(sessionId, this.get(sessionId).currentThreadId, (thread) => ({ ...thread, model: model ? { ...model } : undefined }), true);
	}
	createThread(sessionId: string): void {
		const state = this.get(sessionId);
		const current = state.threads.find((thread) => thread.id === state.currentThreadId);
		if (current && !current.messages.length && !current.draft) return;
		const thread = this.newThread(current?.model);
		this.update(sessionId, { ...state, currentThreadId: thread.id, threads: [...state.threads, thread] }, true);
	}
	selectThread(sessionId: string, threadId: string): void {
		const state = this.get(sessionId);
		if (state.threads.some((thread) => thread.id === threadId)) this.update(sessionId, { ...state, currentThreadId: threadId }, true);
	}

	send(sessionId: string, retry = false): void {
		const state = this.get(sessionId);
		const thread = state.threads.find((item) => item.id === state.currentThreadId);
		if (!thread || thread.request) return;
		const previous = thread.messages.at(-1);
		const retrying = retry && previous?.role === "assistant" && previous.status === "error" && thread.messages.at(-2)?.role === "user";
		const text = (retrying ? thread.messages.at(-2)!.text : thread.draft).trim();
		if (!text) return;
		const requestId = this.options.id();
		const historyMessages = retrying ? thread.messages.slice(0, -2) : thread.messages;
		const availableHistory: SideChatHistoryMessage[] = historyMessages.filter((message) => message.text && (message.role === "user" || message.status === "done" || message.status === "aborted"))
			.map(({ role, text }) => ({ role, text }));
		const { history, truncated } = requestHistory(availableHistory);
		const messages: SideChatMessage[] = retrying
			? [...thread.messages.slice(0, -1), { id: previous!.id, role: "assistant", text: "", status: "pending", contextTruncated: truncated }]
			: [...thread.messages, { id: this.options.id(), role: "user", text }, { id: this.options.id(), role: "assistant", text: "", status: "pending", contextTruncated: truncated }];
		this.updateThread(sessionId, thread.id, (item) => ({ ...item, title: item.title || text.slice(0, 80), messages, draft: retrying ? item.draft : "", request: { id: requestId, revision: -1 }, connectionLost: false }), true);
		void this.run(sessionId, thread.id, requestId, { requestId, threadId: thread.id, text, history, ...(thread.model ? { model: { ...thread.model } } : {}) });
	}

	private apply(sessionId: string, threadId: string, requestId: string, progress: SideChatProgress): void {
		this.updateThread(sessionId, threadId, (thread) => {
			if (thread.request?.id !== requestId) return thread;
			const previousText = thread.messages.at(-1)?.text ?? "";
			if (progress.textOffset !== undefined && progress.textOffset > previousText.length) throw new Error("side-chat answer cursor is out of sync");
			const text = progress.textOffset === undefined ? progress.text : previousText.slice(0, progress.textOffset) + progress.text;
			const status = !progress.done ? "pending" : progress.error ? "error" : progress.aborted ? "aborted" : "done";
			return {
				...thread, activeTool: progress.done ? null : progress.activeTool, connectionLost: false, request: progress.done ? undefined : { id: requestId, revision: progress.revision },
				// 只在这次响应真的报了就更新；没报就保持上一次的值（不回落成 0）
				...(progress.usage ? { usage: progress.usage } : {}),
				...(progress.contextWindow ? { contextWindow: progress.contextWindow } : {}),
				...(progress.characters ? { characters: progress.characters } : {}),
				messages: thread.messages.map((message, index) => index === thread.messages.length - 1 ? {
					...message, text, status, error: progress.error, contextTruncated: message.contextTruncated || progress.contextTruncated, lengthLimited: progress.lengthLimited,
				} : message),
			};
		}, progress.done);
	}
	private fail(sessionId: string, threadId: string, requestId: string, error: string): void {
		const thread = this.get(sessionId).threads.find((item) => item.id === threadId);
		this.apply(sessionId, threadId, requestId, { requestId, revision: 0, text: thread?.messages.at(-1)?.text ?? "", done: true, aborted: false, error });
	}
	private async response(response: Response): Promise<SideChatProgress> {
		const json = await response.json();
		if (!response.ok || !json.success) throw new ApiError(json.error || `side-chat request failed (${response.status})`, response.status);
		const data = json.data as SideChatProgress;
		if (!data || !isSideChatId(data.requestId) || !Number.isSafeInteger(data.revision) || typeof data.text !== "string" || typeof data.done !== "boolean" || (data.textOffset !== undefined && (!Number.isSafeInteger(data.textOffset) || data.textOffset < 0))) throw new Error("invalid side-chat response");
		return data;
	}
	private async run(sessionId: string, threadId: string, requestId: string, initial?: SideChatRequest): Promise<void> {
		if (this.requests.has(requestId)) return;
		const controller = new AbortController();
		this.requests.set(requestId, controller);
		const url = `/api/agent/${sessionId}/side-chat`;
		let revision = this.get(sessionId).threads.find((thread) => thread.id === threadId)?.request?.revision ?? -1;
		try {
			if (initial) {
				const progress = await this.response(await this.options.fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(initial), signal: controller.signal }));
				if (progress.requestId !== requestId) throw new Error("side-chat response belongs to a different request");
				if (controller.signal.aborted) return;
				this.apply(sessionId, threadId, requestId, progress);
				if (progress.done) return;
				revision = progress.revision;
			}
			let failures = 0;
			while (!controller.signal.aborted) {
				let progress: SideChatProgress;
				try {
					progress = await this.response(await this.options.fetch(`${url}?requestId=${encodeURIComponent(requestId)}&after=${revision}`, { cache: "no-store", signal: controller.signal }));
					if (progress.requestId !== requestId) throw new Error("side-chat response belongs to a different request");
				} catch (error) {
					if (controller.signal.aborted) return;
					if (error instanceof ApiError || ++failures >= 6) throw error;
					this.updateThread(sessionId, threadId, (thread) => ({ ...thread, connectionLost: true }));
					await pause(Math.min(500 * 2 ** (failures - 1), 5000), controller.signal);
					continue;
				}
				if (controller.signal.aborted) return;
				failures = 0;
				this.apply(sessionId, threadId, requestId, progress);
				if (progress.done) return;
				revision = progress.revision;
			}
		} catch (error) {
			if (!controller.signal.aborted) this.fail(sessionId, threadId, requestId, error instanceof Error ? error.message : "side-chat request failed");
		} finally {
			if (this.requests.get(requestId) === controller) this.requests.delete(requestId);
		}
	}

	stop(sessionId: string): void {
		const thread = this.get(sessionId).threads.find((item) => item.id === this.get(sessionId).currentThreadId);
		const requestId = thread?.request?.id;
		if (!thread || !requestId) return;
		this.requests.get(requestId)?.abort();
		this.apply(sessionId, thread.id, requestId, { requestId, revision: 0, text: thread.messages.at(-1)?.text ?? "", done: true, aborted: true });
		void this.options.fetch(`/api/agent/${sessionId}/side-chat?requestId=${encodeURIComponent(requestId)}`, { method: "DELETE" })
			.then(async (response) => { if (!response.ok) throw new Error((await response.json()).error || "failed to stop side-chat answer"); })
			.catch((error) => this.updateThread(sessionId, thread.id, (current) => ({ ...current, messages: current.messages.map((message) => message.id === thread.messages.at(-1)?.id ? { ...message, error: error instanceof Error ? error.message : "failed to stop side-chat answer" } : message) }), true));
	}
}

export const sideChatStore = new SideChatStore();
if (typeof window !== "undefined") window.addEventListener("pagehide", sideChatStore.flush);
