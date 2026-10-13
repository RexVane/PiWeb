"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import dynamic from "next/dynamic";
import { IconChevronDown14, IconCloseOutline14, IconNewChatOutline16, IconSendArrowUp14, IconStopFill16 } from "@/components/icons";
import { ContextMeter } from "@/components/ContextMeter";
import { ModelSelector, type ModelChoice } from "@/components/ModelSelector";
import { useI18n } from "@/i18n";
import { EMPTY_SIDE_CHAT, sideChatStore, type SideChatStore } from "./store";
import styles from "./SideChatPanel.module.css";

const Markdown = dynamic(() => import("@/components/MarkdownBlock").then((module) => module.MarkdownBlock));
const StreamingMarkdown = dynamic(() => import("@/components/MarkdownBlock").then((module) => module.StreamingMarkdownBlock));

export function SideChatPanel({ sessionId, ready = true, mainModel, models = [], providerNames = {}, authByProvider = {}, onClose, store = sideChatStore }: {
	sessionId: string | null;
	ready?: boolean;
	mainModel?: { provider: string; id: string; name: string };
	models?: ModelChoice[];
	providerNames?: Record<string, string>;
	authByProvider?: Record<string, boolean>;
	onClose: () => void;
	store?: SideChatStore;
}) {
	const { t } = useI18n();
	const subscribe = useCallback((listener: () => void) => store.subscribe(sessionId, listener), [sessionId, store]);
	const getSnapshot = useCallback(() => store.get(sessionId), [sessionId, store]);
	const state = useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_SIDE_CHAT);
	const thread = state.threads.find((item) => item.id === state.currentThreadId);
	const scrollRef = useRef<HTMLDivElement>(null);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const pinned = useRef(true);
	const lastTop = useRef(0);
	const busy = Boolean(thread?.request);
	const threadId = thread?.id;
	/** 历史记录菜单是否展开 */
	const [historyOpen, setHistoryOpen] = useState(false);
	const historyRef = useRef<HTMLDivElement>(null);
	const selectedModel = thread?.model
		? models.find((model) => model.provider === thread.model!.provider && model.id === thread.model!.id) ?? { ...thread.model, name: thread.model.id }
		: mainModel;
	const canSend = Boolean(sessionId && ready && selectedModel);

	useEffect(() => {
		pinned.current = true;
		lastTop.current = 0;
		if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
	}, [sessionId, threadId]);
	useEffect(() => {
		const node = scrollRef.current;
		if (!node) return;
		const pin = () => { if (pinned.current) node.scrollTop = node.scrollHeight; };
		const observer = new ResizeObserver(pin);
		if (node.firstElementChild) observer.observe(node.firstElementChild);
		pin();
		return () => observer.disconnect();
	}, [thread?.messages]);
	useEffect(() => {
		const textarea = textareaRef.current;
		if (!textarea) return;
		textarea.style.height = "auto";
		textarea.style.height = `${Math.min(180, Math.max(64, textarea.scrollHeight))}px`;
	}, [thread?.draft, threadId]);

	// 历史记录菜单：点外部或 Esc 关掉（与圆环弹窗同一套做法）
	useEffect(() => {
		if (!historyOpen) return;
		const onDown = (event: MouseEvent) => {
			if (!historyRef.current?.contains(event.target as Node)) setHistoryOpen(false);
		};
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") setHistoryOpen(false);
		};
		document.addEventListener("mousedown", onDown);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("mousedown", onDown);
			document.removeEventListener("keydown", onKey);
		};
	}, [historyOpen]);

	// 上下文：这次问出去的真实 prompt（input + 缓存读写）对上该模型的窗口。
	// 没有真实用量就一律 null —— 圆环显示「用量未知」，不编数字。
	const usage = thread?.usage;
	const contextTokens = usage ? usage.input + usage.cacheRead + usage.cacheWrite : null;
	const contextWindow = thread?.contextWindow ?? null;
	const contextPercent = contextTokens !== null && contextWindow ? (contextTokens / contextWindow) * 100 : null;

	const send = () => {
		if (!sessionId || !canSend || busy || !thread?.draft.trim()) return;
		pinned.current = true;
		store.send(sessionId);
		textareaRef.current?.focus({ preventScroll: true });
	};

	return (
		<section className={styles.panel} aria-label={t.sideChat} data-testid="side-chat-panel">
			<header className={styles.header}>
				<span className={styles.title}>{t.sideChat}</span>
				<button type="button" className="icon-btn" aria-label={t.sideChatNew} title={t.sideChatNew} disabled={!sessionId} onClick={() => sessionId && store.createThread(sessionId)}>
					<IconNewChatOutline16 size={16} />
				</button>
				<button type="button" className="icon-btn" aria-label={t.close} title={t.close} onClick={onClose}><IconCloseOutline14 size={14} /></button>
			</header>
			{state.threads.length > 1 && (
				// 原生 select 在深色界面里是系统白底菜单（又丑又不跟主题），改用与模型选择器一致的浮层菜单
				<div className={styles.history} ref={historyRef}>
					<button type="button" className={styles.historyButton} aria-label={t.sideChatHistory} aria-haspopup="menu" aria-expanded={historyOpen} onClick={() => setHistoryOpen((open) => !open)}>
						<span className="truncate">{thread ? `${thread.title || t.sideChatNew}${thread.request ? " · …" : ""}` : t.sideChatHistory}</span>
						<IconChevronDown14 size={12} style={{ flex: "none", color: "var(--dsw-label-caption)" }} />
					</button>
					{historyOpen && (
						<div className={styles.historyMenu} role="menu" aria-label={t.sideChatHistory}>
							{[...state.threads].reverse().map((item) => (
								<button key={item.id} type="button" role="menuitemradio" aria-checked={item.id === threadId} className={styles.historyItem}
									onClick={() => { if (sessionId) store.selectThread(sessionId, item.id); setHistoryOpen(false); }}>
									<span className="truncate">{item.title || t.sideChatNew}</span>
									{item.request ? <span className={styles.historyMeta}>…</span> : null}
								</button>
							))}
						</div>
					)}
				</div>
			)}
			<div className={styles.messages} ref={scrollRef} role="log" aria-label={t.sideChatMessages} aria-live="polite" aria-relevant="additions" onScroll={(event) => {
				const node = event.currentTarget;
				const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
				const movedUp = node.scrollTop < lastTop.current - 1 && distance > 2;
				pinned.current = !movedUp && distance < 48;
				lastTop.current = node.scrollTop;
			}}>
				<div className={styles.messageContent}>
					{!thread?.messages.length ? (
						<div className={styles.empty}>
							<p>{sessionId ? t.sideChatEmpty : t.sideChatPickSession}</p>
							{sessionId && <span>{t.sideChatHint}</span>}
						</div>
					) : thread.messages.map((message) => (
						<div key={message.id} className={message.role === "user" ? styles.question : styles.answer} data-role={message.role}>
							{message.role === "user" ? message.text : <>
								{message.contextTruncated && <p className={styles.notice}>{t.sideChatContextTruncated}</p>}
								{message.text && (message.status === "pending" ? <StreamingMarkdown text={message.text} /> : <Markdown text={message.text} />)}
								{message.status === "pending" && !message.text && <span className={styles.waiting} role="status">{thread.connectionLost ? t.reconnecting : t.sideChatAnswering}</span>}
								{message.error && <div className={styles.error} role="alert">{message.error}{message.status === "error" && message === thread.messages.at(-1) && <button type="button" disabled={busy} onClick={() => sessionId && store.send(sessionId, true)}>{t.retry}</button>}</div>}
								{message.status === "aborted" && <p className={styles.notice}>{t.turnAborted}</p>}
								{message.lengthLimited && <p className={styles.notice}>{t.sideChatLengthLimited}</p>}
							</>}
						</div>
					))}
				</div>
			</div>
			{state.storageFailed && <p className={styles.storageError} role="alert">{t.sideChatStorageFailed}</p>}
			<form className={styles.composer} onSubmit={(event) => { event.preventDefault(); send(); }}>
				<textarea ref={textareaRef} aria-label={t.sideChatQuestion} placeholder={sessionId ? t.sideChatPlaceholder : t.sideChatPickSession} value={thread?.draft ?? ""} disabled={!canSend}
					onChange={(event) => sessionId && store.setDraft(sessionId, event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) { event.preventDefault(); send(); }
					}} />
				<div className={styles.actions}>
					<div className={styles.model} role="group" aria-label={t.sideChatModel}>
						<ModelSelector model={selectedModel} models={models} providerNames={providerNames} authByProvider={authByProvider}
							modelOnly disabled={!sessionId} thinkingLevels={[]} onSelectLevel={() => {}}
							defaultOption={{ label: t.sideChatFollowMain, selected: !thread?.model, onSelect: () => sessionId && store.setModel(sessionId) }}
							onSelectModel={(provider, id) => sessionId && store.setModel(sessionId, { provider, id })} />
					</div>
					<div className={styles.meter}>
						<ContextMeter
							percent={contextPercent}
							tokens={contextTokens}
							contextWindow={contextWindow}
							label={t.contextMeasured}
							source={thread?.characters ? {
								systemChars: 0,
								messages: thread.messages.map((message) => ({ role: message.role, content: [{ type: "text", text: message.text }] })),
								breakdown: {
									characters: { systemPrompt: thread.characters.systemPrompt, background: thread.characters.background, systemTools: 0, customTools: 0, memory: 0, skills: 0, compacted: 0 },
									systemPrompt: 0, systemTools: 0, customTools: 0, memory: 0, skills: 0, compacted: 0, autoCompactBuffer: 0,
								},
							} : undefined}
							model={selectedModel ? { provider: selectedModel.provider, id: selectedModel.id } : null}
						/>
					</div>
					{busy ? <button type="button" className={styles.send} title={t.stop} aria-label={t.stop} onClick={() => sessionId && store.stop(sessionId)}><IconStopFill16 size={15} /></button>
						: <button type="submit" className={styles.send} title={t.send} aria-label={t.send} disabled={!canSend || !thread?.draft.trim()}><IconSendArrowUp14 size={16} /></button>}
				</div>
			</form>
		</section>
	);
}
