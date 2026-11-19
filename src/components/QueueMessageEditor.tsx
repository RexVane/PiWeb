"use client";
import { useLayoutEffect, useRef, useState } from "react";
import { useI18n } from "@/i18n";
import { IconCheckOutline14, IconCloseOutline14 } from "./icons";
import { MAX_MESSAGE_CHARS } from "@/lib/chat/image-attachment";
import type { SendResult } from "./ChatInput";

export function QueueMessageEditor({ initialText, stale, onSave, onCancel }: {
	initialText: string; stale: boolean; onSave: (text: string) => Promise<SendResult | void>; onCancel: () => void;
}) {
	const { t } = useI18n();
	const [text, setText] = useState(initialText);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const input = useRef<HTMLTextAreaElement>(null);
	const inFlight = useRef(false);
	const composing = useRef(false);
	useLayoutEffect(() => { input.current?.focus(); input.current?.setSelectionRange(initialText.length, initialText.length); }, [initialText]);
	useLayoutEffect(() => { if (input.current) { input.current.style.height = "0px"; input.current.style.height = `${Math.max(28, Math.min(120, input.current.scrollHeight))}px`; } }, [text]);
	const save = async () => {
		if (inFlight.current || stale || !text.trim()) return;
		inFlight.current = true; setBusy(true); setError("");
		try { const result = await onSave(text); if (result?.success === false) setError(result.error || t.toastError); }
		catch (failure) { setError(failure instanceof Error ? failure.message : t.toastError); }
		finally { inFlight.current = false; setBusy(false); }
	};
	return <div className="pw-queue-inline-wrap" data-testid="queue-inline-editor">
		<div className="pw-queue-inline">
			<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M13.5 7.5a5.5 5.5 0 0 1-5.5 5.5H3l-1 1V7.5a5.5 5.5 0 0 1 11 0Z" stroke="currentColor" /><path d="M5 6h5M5 9h3" stroke="currentColor" /></svg>
			<textarea ref={input} rows={1} value={text} disabled={busy} aria-label={t.queueEdit} maxLength={MAX_MESSAGE_CHARS}
				onChange={(event) => { setText(event.target.value); setError(""); }}
				onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
				onKeyDown={(event) => {
					if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
					if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (!busy) onCancel(); }
					if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.stopPropagation(); void save(); }
				}} />
			<button type="button" className="icon-btn" disabled={busy || stale || !text.trim()} title={t.queueSaveEdit} aria-label={t.queueSaveEdit} onClick={() => void save()}><IconCheckOutline14 size={15} /></button>
			<button type="button" className="icon-btn" disabled={busy} title={t.queueCancelEdit} aria-label={t.queueCancelEdit} onClick={onCancel}><IconCloseOutline14 size={15} /></button>
		</div>
		{(stale || error) && <p role="alert" className="pw-queue-edit-error">{stale ? t.apiErrorQueueChanged : error}</p>}
	</div>;
}
