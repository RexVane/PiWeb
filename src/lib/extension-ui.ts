/**
 * extension-ui：把 pi 扩展的界面请求（select / confirm / input / notify / setStatus）
 * 桥接到浏览器——与 pi 自己的 RPC 模式（extension_ui_request / extension_ui_response）同一套语义。
 * 没有页面在看时（无订阅者）select/input 返回 undefined、confirm 返回 false，与 pi 的 noOp 行为一致。
 */
import { randomUUID } from "node:crypto";
import type { WebEvent } from "./types";

type UiMethod = Extract<WebEvent, { type: "extension_ui" }>["method"];
type UiEvent = Extract<WebEvent, { type: "extension_ui" }>;

interface PendingUi {
	resolve: (response: { value?: string; confirmed?: boolean; cancelled?: boolean }) => void;
	timer?: ReturnType<typeof setTimeout>;
}

export interface ExtensionUiBridge {
	/** 供 AgentSession.bindExtensions 的 uiContext（只实现 Web 能承接的部分，其余 no-op） */
	uiContext: Record<string, unknown>;
	/** 浏览器应答 */
	respond(requestId: string, response: { value?: string; confirmed?: boolean; cancelled?: boolean }): boolean;
	/** 会话销毁：把挂起的对话框全部按取消结束 */
	dispose(): void;
	/** 扩展通过 setStatus 设的状态文本（页脚展示） */
	statuses: Map<string, string>;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export function createExtensionUiBridge(opts: {
	publish: (evt: WebEvent) => void;
	hasViewers: () => boolean;
}): ExtensionUiBridge {
	const pending = new Map<string, PendingUi>();
	const statuses = new Map<string, string>();

	const ask = <T,>(
		request: Omit<UiEvent, "type" | "id" | "ts">,
		dialogOpts: { signal?: AbortSignal; timeout?: number } | undefined,
		fallback: T,
		parse: (r: { value?: string; confirmed?: boolean; cancelled?: boolean }) => T,
	): Promise<T> => {
		// 没有浏览器在看：不能永远挂着扩展，按 pi 的 noOp 语义立即返回默认值
		if (!opts.hasViewers()) return Promise.resolve(fallback);
		const id = randomUUID();
		return new Promise<T>((resolve) => {
			const finish = (r: { value?: string; confirmed?: boolean; cancelled?: boolean } | null) => {
				const entry = pending.get(id);
				if (!entry) return;
				pending.delete(id);
				if (entry.timer) clearTimeout(entry.timer);
				resolve(r ? parse(r) : fallback);
			};
			const entry: PendingUi = { resolve: (r) => finish(r) };
			const timeout = dialogOpts?.timeout ?? DEFAULT_TIMEOUT_MS;
			entry.timer = setTimeout(() => finish(null), timeout);
			dialogOpts?.signal?.addEventListener("abort", () => finish(null), { once: true });
			pending.set(id, entry);
			opts.publish({ type: "extension_ui", id, ...request, timeout: dialogOpts?.timeout, ts: Date.now() });
		});
	};

	const uiContext: Record<string, unknown> = {
		select: (title: string, options: string[], o?: { signal?: AbortSignal; timeout?: number }) =>
			ask<string | undefined>({ method: "select", title, options }, o, undefined, (r) => (r.cancelled ? undefined : r.value)),
		confirm: (title: string, message: string, o?: { signal?: AbortSignal; timeout?: number }) =>
			ask<boolean>({ method: "confirm", title, message }, o, false, (r) => (r.cancelled ? false : r.confirmed === true)),
		input: (title: string, placeholder?: string, o?: { signal?: AbortSignal; timeout?: number }) =>
			ask<string | undefined>({ method: "input", title, placeholder }, o, undefined, (r) => (r.cancelled ? undefined : r.value)),
		notify: (message: string, type?: "info" | "warning" | "error") => {
			opts.publish({ type: "extension_ui", id: randomUUID(), method: "notify", message, notifyType: type ?? "info", ts: Date.now() });
		},
		setStatus: (key: string, text: string | undefined) => {
			if (text === undefined) statuses.delete(key);
			else statuses.set(key, text);
			opts.publish({ type: "extension_ui", id: randomUUID(), method: "setStatus", statusKey: key, statusText: text, ts: Date.now() });
		},
		setWorkingMessage: (message?: string) => {
			opts.publish({ type: "extension_ui", id: randomUUID(), method: "setWorkingMessage", message, ts: Date.now() });
		},
		// 终端专属能力：Web 无对应物，按 pi 的 noOp 处理
		onTerminalInput: () => () => {},
		setWorkingVisible: () => {},
		setWorkingIndicator: () => {},
		setHiddenThinkingLabel: () => {},
		setWidget: () => {},
		setFooter: () => {},
		setHeader: () => {},
		setTitle: () => {},
		custom: async () => undefined,
		pasteToEditor: () => {},
		setEditorText: () => {},
		getEditorText: () => "",
		editor: async () => undefined,
		addAutocompleteProvider: () => {},
		setEditorComponent: () => {},
		getEditorComponent: () => undefined,
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: () => {},
		getToolsExpanded: () => false,
		setToolsExpanded: () => {},
	};

	return {
		uiContext,
		statuses,
		respond(requestId, response) {
			const entry = pending.get(requestId);
			if (!entry) return false;
			entry.resolve(response);
			return true;
		},
		dispose() {
			for (const entry of pending.values()) entry.resolve({ cancelled: true });
			pending.clear();
		},
	};
}

export type { UiMethod };
