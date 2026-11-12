/**
 * extension-ui：把 pi 扩展的界面请求桥接到浏览器——与 pi 自己的 RPC 模式
 * （extension_ui_request / extension_ui_response）同一套语义、同一份支持清单：
 * 对话框 select / confirm / input / editor 等应答，notify / setStatus / setWidget / setTitle /
 * setEditorText 只通知。其余依赖真实终端的能力（custom、setFooter、自定义编辑器…）与 RPC 模式一样是 no-op。
 * 没有页面在看时（无订阅者）select/input/editor 返回 undefined、confirm 返回 false，与 pi 的 noOp 行为一致。
 */
import { randomUUID } from "node:crypto";
import { ASK_USER_TIMEOUT_MS, parseAnswers, type AskOutcome, type AskQuestion } from "./ask-user";
import type { WebEvent, WebExtensionWidget } from "./types";

type UiMethod = Extract<WebEvent, { type: "extension_ui" }>["method"];
type UiEvent = Extract<WebEvent, { type: "extension_ui" }>;

interface PendingUi {
	request: UiEvent;
	resolve: (response: { value?: string; confirmed?: boolean; cancelled?: boolean }) => void;
	timer?: ReturnType<typeof setTimeout>;
	removeAbortListener?: () => void;
}

export interface ExtensionUiBridge {
	/** 供 AgentSession.bindExtensions 的 uiContext（只实现 Web 能承接的部分，其余 no-op） */
	uiContext: Record<string, unknown>;
	/** 浏览器应答 */
	respond(requestId: string, response: { value?: string; confirmed?: boolean; cancelled?: boolean }): boolean;
	/** 当前仍待应答的请求，不含已答/取消/过期请求。 */
	getPendingRequests(): UiEvent[];
	/** 会话销毁：把挂起的对话框全部按取消结束 */
	dispose(): void;
	/**
	 * ask_user_question 的选择窗口。与扩展对话框不同：没有页面在看也挂着等（用户回来打开页面就能答），
	 * 最多 30 分钟；超时 / 中止 → timeout，用户跳过或会话销毁 → skipped。
	 */
	askQuestions(questions: AskQuestion[], signal?: AbortSignal): Promise<AskOutcome>;
	/** 扩展通过 setStatus 设的状态文本（页脚展示） */
	statuses: Map<string, string>;
	/** 扩展通过 setWidget 设的文字块（输入框上方 / 下方） */
	widgets: Map<string, WebExtensionWidget>;
	/** 扩展通过 setTitle 设的窗口标题 */
	getTitle(): string | undefined;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
/** 单个 widget 的上限：扩展把整份日志塞进来时不能撑爆快照和 SSE 帧 */
const WIDGET_MAX_LINES = 200;
const WIDGET_MAX_LINE_CHARS = 2_000;

const plainText = (text: unknown): string => (typeof text === "string" ? text : String(text ?? ""));
/** 扩展自己用 chalk 之类上的色：Web 不渲染 ANSI，原样显示就是一串乱码，去掉转义序列只留文字 */
const ANSI_SEQUENCE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const displayText = (text: unknown): string => plainText(text).replace(ANSI_SEQUENCE, "");
/**
 * 扩展常写 `ctx.ui.theme.fg("accent", text)` 给状态文字上色；pi 的 noOp 上下文也带 theme。
 * 缺了它扩展一调就抛 TypeError。Web 不渲染 ANSI，所以给一个原样返回文字、不加任何转义序列的主题。
 */
const PLAIN_THEME = {
	name: "piweb-plain",
	style: (text: string) => plainText(text),
	fg: (_color: string, text: string) => plainText(text),
	bg: (_color: string, text: string) => plainText(text),
	bold: plainText,
	italic: plainText,
	underline: plainText,
	inverse: plainText,
	strikethrough: plainText,
	getFgAnsi: () => "",
	getBgAnsi: () => "",
	getColorMode: () => "truecolor",
	getThinkingBorderColor: () => plainText,
	getBashModeBorderColor: () => plainText,
};

export function createExtensionUiBridge(opts: {
	publish: (evt: WebEvent) => void;
	hasViewers: () => boolean;
}): ExtensionUiBridge {
	const pending = new Map<string, PendingUi>();
	const statuses = new Map<string, string>();
	const widgets = new Map<string, WebExtensionWidget>();
	let title: string | undefined;
	let disposed = false;

	const ask = <T,>(
		request: Omit<UiEvent, "type" | "id" | "ts">,
		dialogOpts: { signal?: AbortSignal; timeout?: number; waitForViewer?: boolean } | undefined,
		fallback: T,
		parse: (r: { value?: string; confirmed?: boolean; cancelled?: boolean }) => T,
	): Promise<T> => {
		// 没有浏览器在看：不能永远挂着扩展，按 pi 的 noOp 语义立即返回默认值（选择窗口例外，见 askQuestions）
		if (disposed || (!dialogOpts?.waitForViewer && !opts.hasViewers()) || dialogOpts?.signal?.aborted) return Promise.resolve(fallback);
		const id = randomUUID();
		return new Promise<T>((resolve) => {
			const finish = (r: { value?: string; confirmed?: boolean; cancelled?: boolean } | null) => {
				const entry = pending.get(id);
				if (!entry) return;
				pending.delete(id);
				if (entry.timer) clearTimeout(entry.timer);
				entry.removeAbortListener?.();
				opts.publish({ type: "extension_ui_resolved", id, ts: Date.now() });
				resolve(r ? parse(r) : fallback);
			};
			const event: UiEvent = { type: "extension_ui", id, ...request, timeout: dialogOpts?.timeout, ts: Date.now() };
			const entry: PendingUi = { request: event, resolve: (r) => finish(r) };
			const timeout = dialogOpts?.timeout ?? DEFAULT_TIMEOUT_MS;
			entry.timer = setTimeout(() => finish(null), timeout);
			entry.timer.unref?.();
			const onAbort = () => finish(null);
			dialogOpts?.signal?.addEventListener("abort", onAbort, { once: true });
			entry.removeAbortListener = () => dialogOpts?.signal?.removeEventListener("abort", onAbort);
			pending.set(id, entry);
			opts.publish(event);
		});
	};

	const uiContext: Record<string, unknown> = {
		select: (title: string, options: string[], o?: { signal?: AbortSignal; timeout?: number }) =>
			ask<string | undefined>({ method: "select", title, options }, o, undefined, (r) => (r.cancelled ? undefined : r.value)),
		confirm: (title: string, message: string, o?: { signal?: AbortSignal; timeout?: number }) =>
			ask<boolean>({ method: "confirm", title, message }, o, false, (r) => (r.cancelled ? false : r.confirmed === true)),
		input: (title: string, placeholder?: string, o?: { signal?: AbortSignal; timeout?: number }) =>
			ask<string | undefined>({ method: "input", title, placeholder }, o, undefined, (r) => (r.cancelled ? undefined : r.value)),
		editor: (title: string, prefill?: string, o?: { signal?: AbortSignal; timeout?: number }) =>
			ask<string | undefined>({ method: "editor", title, prefill: typeof prefill === "string" ? prefill : undefined }, o, undefined, (r) => (r.cancelled ? undefined : r.value)),
		notify: (message: string, type?: "info" | "warning" | "error") => {
			opts.publish({ type: "extension_ui", id: randomUUID(), method: "notify", message, notifyType: type ?? "info", ts: Date.now() });
		},
		setStatus: (key: string, text: string | undefined) => {
			const shown = text === undefined ? undefined : displayText(text);
			if (shown === undefined) statuses.delete(key);
			else statuses.set(key, shown);
			opts.publish({ type: "extension_ui", id: randomUUID(), method: "setStatus", statusKey: key, statusText: shown, ts: Date.now() });
		},
		setWorkingMessage: (message?: string) => {
			opts.publish({ type: "extension_ui", id: randomUUID(), method: "setWorkingMessage", message, ts: Date.now() });
		},
		/**
		 * 与 RPC 模式一致：只接字符串数组，组件工厂（需要真实终端来渲染）忽略。
		 * 忽略时不清掉同 key 的旧内容——扩展先发文字、再想升级成组件时，文字版仍是能看的那一个。
		 */
		setWidget: (key: string, content: unknown, options?: { placement?: string }) => {
			if (typeof key !== "string" || !key) return;
			if (content !== undefined && !Array.isArray(content)) return;
			const placement = options?.placement === "belowEditor" ? "belowEditor" : "aboveEditor";
			if (content === undefined) {
				if (!widgets.delete(key)) return;
				opts.publish({ type: "extension_ui", id: randomUUID(), method: "setWidget", widgetKey: key, ts: Date.now() });
				return;
			}
			const lines = content.slice(0, WIDGET_MAX_LINES).map((line) => displayText(line).slice(0, WIDGET_MAX_LINE_CHARS));
			widgets.set(key, { lines, placement });
			opts.publish({ type: "extension_ui", id: randomUUID(), method: "setWidget", widgetKey: key, widgetLines: lines, widgetPlacement: placement, ts: Date.now() });
		},
		setTitle: (value: string) => {
			const shown = displayText(value).trim();
			title = shown ? shown.slice(0, 200) : undefined;
			opts.publish({ type: "extension_ui", id: randomUUID(), method: "setTitle", title: title ?? "", ts: Date.now() });
		},
		setEditorText: (text: string) => {
			opts.publish({ type: "extension_ui", id: randomUUID(), method: "setEditorText", text: plainText(text), ts: Date.now() });
		},
		// RPC 模式同款：没有终端粘贴处理，直接当成设置输入框文字
		pasteToEditor: (text: string) => {
			opts.publish({ type: "extension_ui", id: randomUUID(), method: "setEditorText", text: plainText(text), ts: Date.now() });
		},
		// 终端专属能力：Web 无对应物，按 pi 的 noOp 处理
		onTerminalInput: () => () => {},
		setWorkingVisible: () => {},
		setWorkingIndicator: () => {},
		setHiddenThinkingLabel: () => {},
		setFooter: () => {},
		setHeader: () => {},
		custom: async () => undefined,
		// 输入框的内容在浏览器里，服务端同步读不到（RPC 模式同样返回空串）
		getEditorText: () => "",
		addAutocompleteProvider: () => {},
		setEditorComponent: () => {},
		getEditorComponent: () => undefined,
		theme: PLAIN_THEME,
		getAllThemes: () => [],
		getTheme: () => undefined,
		// 与 pi 的 noOp 同一返回形状：扩展会读 result.success，返回 undefined 会让它们解构时出错
		setTheme: () => ({ success: false, error: "UI not available" }),
		getToolsExpanded: () => false,
		setToolsExpanded: () => {},
	};

	return {
		uiContext,
		statuses,
		widgets,
		getTitle: () => title,
		askQuestions: async (questions, signal) => {
			if (disposed) return { status: "unavailable" };
			const outcome = await ask<AskOutcome>(
				{ method: "questions", title: "", questions },
				{ signal, timeout: ASK_USER_TIMEOUT_MS, waitForViewer: true },
				{ status: "timeout" },
				(r) => {
					if (r.cancelled) return { status: "skipped" };
					const answers = parseAnswers(questions, r.value);
					return answers ? { status: "answered", answers } : { status: "skipped" };
				},
			);
			// 用户按了停止（signal 中止）不是超时
			return outcome.status === "timeout" && signal?.aborted ? { status: "skipped" } : outcome;
		},
		getPendingRequests: () => [...pending.values()].map(({ request }) => ({
			...request,
			options: request.options ? [...request.options] : undefined,
			...(request.questions ? { questions: structuredClone(request.questions) } : {}),
		})),
		respond(requestId, response) {
			const entry = pending.get(requestId);
			if (!entry) return false;
			entry.resolve(response);
			return true;
		},
		dispose() {
			disposed = true;
			for (const entry of pending.values()) entry.resolve({ cancelled: true });
			pending.clear();
		},
	};
}

export type { UiMethod };
