"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MarkdownBlock } from "@/components/MarkdownBlock";
import { PreviewImage } from "@/components/PreviewImage";
import { useDialog } from "@/hooks/useDialog";
import { clientFetch } from "@/lib/client-fetch";
import { useI18n } from "@/i18n";
import { htmlLangOf, type Lang } from "@/lib/lang";
import type { WebMessage } from "@/lib/types";
import styles from "./SessionHistory.module.css";

interface HistoryPage { messages: WebMessage[]; total: number; olderBefore?: number; newerAfter?: number; pageStart: number; pageEnd: number }
type Cursor = { before?: number; after?: number; reload: number };

type HistoryLabels = {
	title: string;
	notice: string;
	older: string;
	newer: string;
	latest: string;
	loading: string;
	empty: string;
	failed: string;
	retry: string;
	exportFull: string;
	truncated: string;
	thinking: string;
	roles: Record<WebMessage["role"], string>;
};

/** 这个独立的“更早消息”查看器不挂在全局词典里：这里一次给全五种界面语言的文案。 */
const HISTORY_LABELS: Record<Lang, HistoryLabels> = {
	zh: {
		title: "聊天记录",
		notice: "更早的消息仍然保存在会话中。每页查看最多 100 条，不会改变当前对话。",
		older: "更早一页",
		newer: "较新一页",
		latest: "最新一页",
		loading: "正在读取聊天记录…",
		empty: "这一页没有消息。",
		failed: "这一页暂时无法读取，请重试。",
		retry: "重试",
		exportFull: "导出完整会话",
		truncated: "这条较长，当前显示预览；完整内容仍保留在会话导出中。",
		thinking: "思考",
		roles: { user: "你", assistant: "助手", toolResult: "工具结果", custom: "扩展消息", bashExecution: "命令", summary: "摘要", other: "消息" },
	},
	"zh-Hant": {
		title: "聊天記錄",
		notice: "更早的訊息仍保存在工作階段中。每頁最多檢視 100 則，不會改變目前對話。",
		older: "更早一頁",
		newer: "較新一頁",
		latest: "最新一頁",
		loading: "正在讀取聊天記錄…",
		empty: "這一頁沒有訊息。",
		failed: "這一頁暫時無法讀取，請重試。",
		retry: "重試",
		exportFull: "匯出完整工作階段",
		truncated: "這則訊息較長，目前顯示預覽；完整內容仍保留在工作階段匯出中。",
		thinking: "思考",
		roles: { user: "你", assistant: "助理", toolResult: "工具結果", custom: "擴充功能訊息", bashExecution: "指令", summary: "摘要", other: "訊息" },
	},
	en: {
		title: "Chat history",
		notice: "Earlier messages are still saved. Browse 100 messages per page without changing the current chat.",
		older: "Earlier",
		newer: "Newer",
		latest: "Latest page",
		loading: "Loading history…",
		empty: "This page has no messages.",
		failed: "Could not read this page. Try again.",
		retry: "Retry",
		exportFull: "Export full chat",
		truncated: "A preview of this long message is shown. The full content remains in the chat export.",
		thinking: "Thinking",
		roles: { user: "You", assistant: "Assistant", toolResult: "Tool result", custom: "Extension", bashExecution: "Command", summary: "Summary", other: "Message" },
	},
	ja: {
		title: "チャット履歴",
		notice: "以前のメッセージはセッションに保存されています。1 ページにつき 100 件まで表示でき、現在の会話は変わりません。",
		older: "より古い",
		newer: "より新しい",
		latest: "最新",
		loading: "履歴を読み込み中…",
		empty: "このページにメッセージはありません。",
		failed: "このページを読み込めませんでした。もう一度お試しください。",
		retry: "再試行",
		exportFull: "チャット全体をエクスポート",
		truncated: "このメッセージは長いためプレビューを表示しています。完全な内容はセッションのエクスポートに残ります。",
		thinking: "思考",
		roles: { user: "あなた", assistant: "アシスタント", toolResult: "ツール結果", custom: "拡張機能", bashExecution: "コマンド", summary: "要約", other: "メッセージ" },
	},
	ru: {
		title: "История чата",
		notice: "Более старые сообщения по-прежнему сохранены в сеансе. На странице отображается до 100 сообщений, текущий диалог не меняется.",
		older: "Раньше",
		newer: "Новее",
		latest: "Последние",
		loading: "Загрузка истории…",
		empty: "На этой странице нет сообщений.",
		failed: "Не удалось прочитать страницу. Попробуйте ещё раз.",
		retry: "Повторить",
		exportFull: "Экспорт всего чата",
		truncated: "Сообщение длинное, показан предпросмотр. Полное содержимое остаётся в экспорте сеанса.",
		thinking: "Размышления",
		roles: { user: "Вы", assistant: "Ассистент", toolResult: "Результат инструмента", custom: "Расширение", bashExecution: "Команда", summary: "Сводка", other: "Сообщение" },
	},
};

/** Earlier records remain on disk; this separate viewer replaces one bounded page at a time. */
export function SessionHistory({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
	const { lang, t } = useI18n();
	const labels = HISTORY_LABELS[lang];
	const titleId = useId();
	const dialog = useRef<HTMLDivElement>(null); const scroll = useRef<HTMLDivElement>(null);
	useDialog({ open: true, onClose, ref: dialog });
	const [cursor, setCursor] = useState<Cursor>({ reload: 0 });
	const [loaded, setLoaded] = useState<{ sessionId: string; page: HistoryPage } | null>(null);
	const [busy, setBusy] = useState(true); const [error, setError] = useState(false);
	const currentSession = useRef(sessionId);
	const page = loaded?.sessionId === sessionId ? loaded.page : null;

	useEffect(() => {
		if (currentSession.current !== sessionId) {
			currentSession.current = sessionId; setLoaded(null); setCursor({ reload: 0 }); return;
		}
		const controller = new AbortController();
		const query = new URLSearchParams({ limit: "100" });
		if (cursor.before !== undefined) query.set("before", String(cursor.before));
		if (cursor.after !== undefined) query.set("after", String(cursor.after));
		setBusy(true); setError(false);
		void (async () => {
			try {
				const response = await clientFetch(`/api/sessions/${encodeURIComponent(sessionId)}/history?${query}`, { signal: controller.signal });
				const body = await response.json();
				if (!response.ok || body.success !== true || !Array.isArray(body.data?.messages) || body.data.messages.length > 100) throw new Error("invalid history response");
				if (!controller.signal.aborted) { setLoaded({ sessionId, page: body.data }); if (scroll.current) scroll.current.scrollTop = 0; }
			} catch { if (!controller.signal.aborted) setError(true); }
			finally { if (!controller.signal.aborted) setBusy(false); }
		})();
		return () => controller.abort();
	}, [sessionId, cursor]);

	if (typeof document === "undefined") return null;
	return createPortal(<div className={styles.mask} onClick={onClose}>
		<div ref={dialog} className={styles.panel} role="dialog" aria-modal="true" aria-labelledby={titleId} onClick={(event) => event.stopPropagation()}>
			<header className={styles.head}><h2 id={titleId}>{labels.title}</h2><a className={styles.button} href={`/api/sessions/${encodeURIComponent(sessionId)}/export?format=jsonl`} target="_blank" rel="noopener noreferrer">{labels.exportFull}</a><button className={styles.button} type="button" onClick={onClose}>{t.close}</button></header>
			<p className={styles.notice}>{labels.notice}</p>
			<div ref={scroll} className={styles.body} aria-busy={busy}>
				{busy && <p className={styles.status} role="status">{labels.loading}</p>}
				{error && <div role="alert" className={styles.error}>{labels.failed} <button type="button" className={styles.button} onClick={() => setCursor((previous) => ({ ...previous, reload: previous.reload + 1 }))}>{labels.retry}</button></div>}
				{page?.messages.map((message, row) => {
					const images = message.content.filter((part) => part.type === "image");
					const date = typeof message.timestamp === "number" && Number.isFinite(message.timestamp) && Math.abs(message.timestamp) <= 8.64e15 ? new Date(message.timestamp) : null;
					return <article className={styles.message} key={message.id ?? `${page.pageStart}-${row}`}>
						<div className={styles.messageHead}><strong>{labels.roles[message.role]}</strong>{date && <time dateTime={date.toISOString()}>{date.toLocaleString(htmlLangOf(lang))}</time>}</div>
						{message.truncated && <p className={styles.status}>{labels.truncated}</p>}
						{message.summary && <MarkdownBlock text={message.summary} />}
						{message.bash && <pre className={styles.pre}>{message.bash.command}{"\n"}{message.bash.output}</pre>}
						{message.content.map((part, index) => part.type === "text" ? <div className={styles.text} key={index}><MarkdownBlock text={part.text} /></div>
							: part.type === "image" ? <div className={styles.images} key={index}><PreviewImage image={part} images={images} index={images.indexOf(part)} /></div>
							: part.type === "thinking" ? <details key={index}><summary>{labels.thinking}</summary><pre className={styles.pre}>{part.thinking}</pre></details>
							: part.type === "toolCall" ? <details key={index}><summary>{part.name}</summary><pre className={styles.pre}>{JSON.stringify(part.arguments, null, 2)}</pre></details>
							: part.type === "toolResult" ? <pre className={styles.pre} key={index}>{part.text}</pre> : null)}
					</article>;
				})}
				{!busy && !error && page?.messages.length === 0 && <p className={styles.status}>{labels.empty}</p>}
			</div>
			<footer className={styles.footer}>
				<span>{page ? `${page.total ? page.pageStart + 1 : 0}–${page.pageEnd} / ${page.total}` : ""}</span>
				<button type="button" className={styles.button} disabled={busy || page?.olderBefore === undefined} onClick={() => setCursor((previous) => ({ before: page?.olderBefore, reload: previous.reload + 1 }))}>{labels.older}</button>
				<button type="button" className={styles.button} disabled={busy || page?.newerAfter === undefined} onClick={() => setCursor((previous) => ({ after: page?.newerAfter, reload: previous.reload + 1 }))}>{labels.newer}</button>
				<button type="button" className={styles.button} disabled={busy} onClick={() => setCursor((previous) => ({ reload: previous.reload + 1 }))}>{labels.latest}</button>
			</footer>
		</div>
	</div>, document.body);
}
