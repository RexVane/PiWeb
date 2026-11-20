"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { clientFetch } from "@/lib/client-fetch";
import { RESOURCE_FRAME_CHANNEL, type JsonValue, type ResourceFrameContext, type WebResourceView } from "@/lib/resources/protocol";
import { resourceFrameMessage, safeResourceViewUrl } from "@/lib/resources/frame-protocol";
import { useI18n } from "@/i18n";
import { useResourceText } from "./text";

/** A separate opaque-origin document. No DOM access, auth cookie access, arbitrary API URLs or script injection into PiWeb. */
export function ResourceFrame({ view, cwd, sessionPath, request, data, onAnswer, onCancel, onUnavailable }: {
	view: WebResourceView; cwd: string; sessionPath?: string; request?: JsonValue; data?: JsonValue;
	onAnswer?: (value: JsonValue) => void; onCancel?: () => void; onUnavailable?: () => void;
}) {
	const text = useResourceText();
	const { lang } = useI18n();
	const iframe = useRef<HTMLIFrameElement>(null);
	const [height, setHeight] = useState(260);
	const [failed, setFailed] = useState(false);
	const [ready, setReady] = useState(false);
	const token = useMemo(() => crypto.randomUUID(), [view.id, view.url]);
	const callbacks = useRef({ onAnswer, onCancel, onUnavailable });
	callbacks.current = { onAnswer, onCancel, onUnavailable };
	const requestJson = JSON.stringify(request ?? null); const dataJson = JSON.stringify(data ?? null);
	const context = useMemo<ResourceFrameContext>(() => ({ viewId: view.id, resourceId: view.resourceId, scope: view.scope, cwd, sessionPath, preview: view.preview, request: JSON.parse(requestJson), data: JSON.parse(dataJson) }), [view.id, view.resourceId, view.scope, view.preview, cwd, sessionPath, requestJson, dataJson]);
	const latest = useRef({ context, lang, errorText: text.operationFailed });
	latest.current = { context, lang, errorText: text.operationFailed };

	useEffect(() => {
		setFailed(false); setReady(false); setHeight(260);
		if (!safeResourceViewUrl(view.url)) { setFailed(true); return; }
		let active = true;
		let pending = 0;
		const requests = new Set<string>();
		const controller = new AbortController();
		const send = (message: Record<string, unknown>) => { if (active) iframe.current?.contentWindow?.postMessage({ channel: RESOURCE_FRAME_CHANNEL, token, ...message }, "*"); };
		const deadline = setTimeout(() => { if (active) setFailed(true); }, 10_000);
		const receive = (event: MessageEvent) => {
			if (event.source !== iframe.current?.contentWindow) return;
			const message = resourceFrameMessage(event.data, token);
			if (!message) return;
			if (message.type === "ready") {
				clearTimeout(deadline); setReady(true);
				const style = getComputedStyle(document.documentElement);
				const theme = Object.fromEntries(["--dsw-label-primary", "--dsw-label-secondary", "--dsw-label-caption", "--dsw-accent", "--dsw-bg", "--dsw-hover", "--dsw-border-l2", "--dsw-danger"].map((key) => [key, style.getPropertyValue(key).trim()]));
				send({ type: "context", context: latest.current.context, language: latest.current.lang, theme });
			} else if (message.type === "resize") setHeight(message.height!);
			else if (message.type === "answer" && !latest.current.context.preview) callbacks.current.onAnswer?.(message.value ?? null);
			else if (message.type === "cancel") callbacks.current.onCancel?.();
			else if (message.type === "invoke") {
				if (latest.current.context.preview) { send({ type: "result", id: message.id, error: "Passive preview cannot execute backend actions." }); return; }
				if (pending >= 8 || requests.has(message.id!)) return;
				pending += 1; requests.add(message.id!);
				const captured = latest.current.context;
				void clientFetch("/api/resources", { method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
					body: JSON.stringify({ action: "invoke", resourceId: captured.resourceId, scope: captured.scope, cwd: captured.cwd, sessionPath: captured.sessionPath, name: message.name, args: message.args ?? null }),
				}).then(async (response) => {
					const result = await response.json();
					send({ type: "result", id: message.id, ...(result.success ? { value: result.data } : { error: result.error || latest.current.errorText }) });
				}).catch(() => send({ type: "result", id: message.id, error: latest.current.errorText }))
					.finally(() => { pending -= 1; requests.delete(message.id!); });
			}
		};
		window.addEventListener("message", receive);
		return () => { active = false; controller.abort(); clearTimeout(deadline); window.removeEventListener("message", receive); };
	}, [view.id, view.url, token]);

	// Explicit context updates reuse the document, preserving form edits and local component state.
	useEffect(() => {
		if (ready) iframe.current?.contentWindow?.postMessage({ channel: RESOURCE_FRAME_CHANNEL, token, type: "context", context, language: lang }, "*");
	}, [context, lang, ready, token]);

	if (failed || !safeResourceViewUrl(view.url)) return <div role="status" className="flex flex-col gap-2 p-3">
		<span>{text.frameFailed}</span>
		{onUnavailable && <button type="button" className="btn-outline" onClick={() => callbacks.current.onUnavailable?.()}>{text.basicInterface}</button>}
	</div>;
	return <iframe key={`${view.id}:${view.url}`} ref={iframe} src={view.url} title={view.title} sandbox="allow-scripts" referrerPolicy="no-referrer"
		className="w-full rounded-lg" style={{ height, border: 0, background: "transparent" }} onError={() => setFailed(true)} />;
}
