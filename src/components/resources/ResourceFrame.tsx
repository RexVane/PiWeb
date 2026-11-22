"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { clientFetch } from "@/lib/client-fetch";
import { RESOURCE_FRAME_CHANNEL, type JsonValue, type ResourceFrameContext, type ResourceDialogIntent, type WebResourceView } from "@/lib/resources/protocol";
import { resourceFrameMessage, safeResourceViewUrl } from "@/lib/resources/frame-protocol";
import { useI18n } from "@/i18n";
import { useResourceText } from "./text";
import { useResourceNavigation } from "./ResourceNavigation";

const RESOURCE_THEME_PROPERTY = /^--(?:dsw|dsh|pw|isx|ds|font)-/;
const RESOURCE_DOCUMENT_LOAD_TIMEOUT_MS = 30_000;
const RESOURCE_BRIDGE_READY_TIMEOUT_MS = 10_000;
/**
 * 资源帧拿不到宿主样式表，只能把设计令牌作为自定义属性传进去。
 * 从 frame 的挂载点沿祖先链往上读，而不是只读 :root——
 * 皮肤可能把令牌声明在更靠内的容器上，读完子元素覆盖父元素。
 * 只留白名单前缀，业务私有变量不出沙箱。
 */
function collectTheme(from?: Element | null): Record<string, string> {
	const chain: Element[] = [];
	for (let node: Element | null = from ?? null; node; node = node.parentElement) chain.unshift(node);
	if (chain[0] !== document.documentElement) chain.unshift(document.documentElement);
	const theme: Record<string, string> = {};
	for (const element of chain) {
		const style = getComputedStyle(element);
		for (let index = 0; index < style.length; index += 1) {
			const name = style.item(index);
			if (!RESOURCE_THEME_PROPERTY.test(name)) continue;
			const value = style.getPropertyValue(name).trim();
			if (value) theme[name] = value;
		}
	}
	theme["--pw-resource-viewport-height"] = `${window.innerHeight}px`;
	theme["--pw-resource-viewport-width"] = `${window.innerWidth}px`;
	return theme;
}

/** A separate opaque-origin document. No DOM access, auth cookie access, arbitrary API URLs or script injection into PiWeb. */
export function ResourceFrame(props: {
	view: WebResourceView; cwd: string; sessionPath?: string; request?: JsonValue; data?: JsonValue;
	onAnswer?: (value: JsonValue) => void; onCancel?: () => void; onUnavailable?: () => void; onBusyChange?: (busy: boolean) => void;
}) {
	const automatic = isAutomatic(props.view);
	const [attempt, setAttempt] = useState(0);
	return <ResourceFrameBody key={`${props.view.id}:${props.view.url}:${automatic ? JSON.stringify([props.cwd, props.sessionPath]) : ""}:${attempt}`} {...props} onRetry={() => setAttempt((value) => value + 1)} />;
}

function isAutomatic(view: WebResourceView): boolean {
	return view.autoMount === true && (view.placement === "aboveEditor" || view.placement === "belowEditor") && view.methods.length === 0;
}

function ResourceFrameBody({ view, cwd, sessionPath, request, data, onAnswer, onCancel, onUnavailable, onBusyChange, onRetry }: {
	view: WebResourceView; cwd: string; sessionPath?: string; request?: JsonValue; data?: JsonValue;
	onAnswer?: (value: JsonValue) => void; onCancel?: () => void; onUnavailable?: () => void; onBusyChange?: (busy: boolean) => void;
	onRetry: () => void;
}) {
	const text = useResourceText();
	const navigation = useResourceNavigation();
	const { lang } = useI18n();
	const iframe = useRef<HTMLIFrameElement>(null);
	const documentState = useRef<"loading" | "loaded" | "failed">("loading");
	const frameLifecycle = useRef<{ loaded: () => void; fail: () => void } | null>(null);
	const automatic = isAutomatic(view);
	const [height, setHeight] = useState(automatic ? 0 : 260);
	const [failed, setFailed] = useState(false);
	const [ready, setReady] = useState(false);
	const [token] = useState(() => crypto.randomUUID());
	const callbacks = useRef({ onAnswer, onCancel, onUnavailable, onBusyChange });
	callbacks.current = { onAnswer, onCancel, onUnavailable, onBusyChange };
	const requestJson = JSON.stringify(request ?? null); const dataJson = JSON.stringify(data ?? null); const capabilitiesJson = JSON.stringify(view.capabilities ?? []);
	const context = useMemo<ResourceFrameContext>(() => ({ viewId: view.id, resourceId: view.resourceId, scope: view.scope, cwd, sessionPath, preview: view.preview, capabilities: JSON.parse(capabilitiesJson), focusRequestSupported: true, request: JSON.parse(requestJson), data: JSON.parse(dataJson) }), [view.id, view.resourceId, view.scope, view.preview, cwd, sessionPath, requestJson, dataJson, capabilitiesJson]);
	const latest = useRef({ context, lang, navigation, errorText: text.operationFailed });
	latest.current = { context, lang, navigation, errorText: text.operationFailed };

	useEffect(() => {
		setFailed(false); setReady(false); setHeight(automatic ? 0 : 260);
		if (!safeResourceViewUrl(view.url)) { setFailed(true); return; }
		let active = true;
		let bridgeReady = false;
		let loadObserved = false;
		let busy = false;
		let pending = 0;
		const requests = new Set<string>();
		const controller = new AbortController();
		const send = (message: Record<string, unknown>) => { if (active) iframe.current?.contentWindow?.postMessage({ channel: RESOURCE_FRAME_CHANNEL, token, ...message }, "*"); };
		let loadDeadline: ReturnType<typeof setTimeout> | undefined;
		let readyDeadline: ReturnType<typeof setTimeout> | undefined;
		const clearDeadlines = () => {
			if (loadDeadline !== undefined) clearTimeout(loadDeadline);
			if (readyDeadline !== undefined) clearTimeout(readyDeadline);
			loadDeadline = undefined; readyDeadline = undefined;
		};
		const dispose = () => {
			active = false; controller.abort(); clearDeadlines(); window.removeEventListener("message", receive);
			if (busy) { busy = false; callbacks.current.onBusyChange?.(false); }
		};
		const fail = () => {
			if (!active) return;
			documentState.current = "failed";
			dispose(); setReady(false); setFailed(true);
		};
		const loaded = () => {
			if (!active || loadObserved) return;
			loadObserved = true;
			if (loadDeadline !== undefined) clearTimeout(loadDeadline);
			loadDeadline = undefined;
			// A bridge can announce readiness before the document's load event.
			if (!bridgeReady) readyDeadline = setTimeout(fail, RESOURCE_BRIDGE_READY_TIMEOUT_MS);
		};
		const receive = (event: MessageEvent) => {
			if (!active || event.source !== iframe.current?.contentWindow) return;
			const message = resourceFrameMessage(event.data, token, automatic ? 0 : 80);
			if (!message) return;
			if (message.type === "ready") {
				bridgeReady = true; clearDeadlines(); setReady(true);
				send({ type: "context", context: latest.current.context, language: latest.current.lang, theme: collectTheme(iframe.current?.parentElement) });
			} else if (message.type === "resize") setHeight(automatic && message.height! <= 1 ? 0 : message.height!);
			else if (message.type === "focus") {
				const frame = iframe.current;
				const focused = document.activeElement;
				const available = !!frame && (!focused || focused === document.body || focused === frame);
				if (available) frame.focus({ preventScroll: true });
				send({ type: "result", id: message.id, value: available && document.activeElement === frame });
			}
			else if (message.type === "answer" && !latest.current.context.preview) callbacks.current.onAnswer?.(message.value ?? null);
			else if (message.type === "cancel") callbacks.current.onCancel?.();
			else if (message.type === "busy" && !latest.current.context.preview) { busy = message.value === true; callbacks.current.onBusyChange?.(busy); }
			else if (message.type === "invoke" || message.type === "host") {
				const captured = latest.current.context;
				if (captured.preview) { send({ type: "result", id: message.id, error: "Passive preview cannot execute backend actions." }); return; }
				if (message.type === "host" && (!captured.capabilities?.includes(message.name as never)
					|| (message.name?.startsWith("sessions.") || message.name === "views.open") && !latest.current.navigation)) {
					send({ type: "result", id: message.id, error: "Resource host capability is unavailable or not declared." }); return;
				}
				if (pending >= 8 || requests.has(message.id!)) return;
				pending += 1; requests.add(message.id!);
				void clientFetch("/api/resources", { method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
					body: JSON.stringify({ action: message.type === "host" ? "capability" : "invoke", resourceId: captured.resourceId, viewId: captured.viewId, scope: captured.scope, cwd: captured.cwd, sessionPath: captured.sessionPath, name: message.name, args: message.args ?? null }),
				}).then(async (response) => {
					const result = await response.json();
					if (!active) return;
					if (captured.cwd !== latest.current.context.cwd || captured.sessionPath !== latest.current.context.sessionPath) {
						send({ type: "result", id: message.id, error: "Resource context changed during the request." }); return;
					}
					if (message.type === "host" && result.success) {
						if (message.name === "sessions.open" && result.data?.type === "sessions.open" && typeof result.data.sessionPath === "string") latest.current.navigation?.openSession(result.data.sessionPath);
						else if (message.name === "sessions.draft" && result.data?.type === "sessions.draft" && typeof result.data.cwd === "string" && typeof result.data.text === "string") latest.current.navigation?.createDraft(result.data.cwd, result.data.text);
						else if (message.name === "views.open" && result.data?.type === "views.open" && result.data.view?.resourceId === captured.resourceId && result.data.view.scope === captured.scope && result.data.cwd === captured.cwd && safeResourceViewUrl(result.data.view.url)) {
							const value = await latest.current.navigation?.openView(result.data as ResourceDialogIntent, controller.signal);
							send({ type: "result", id: message.id, value }); return;
						}
					}
					send({ type: "result", id: message.id, ...(result.success ? { value: result.data } : { error: result.error || latest.current.errorText }) });
				}).catch(() => send({ type: "result", id: message.id, error: latest.current.errorText }))
					.finally(() => { pending -= 1; requests.delete(message.id!); });
			}
		};
		window.addEventListener("message", receive);
		const lifecycle = { loaded, fail };
		frameLifecycle.current = lifecycle;
		if (documentState.current === "failed") fail();
		else if (documentState.current === "loaded") loaded();
		else loadDeadline = setTimeout(fail, RESOURCE_DOCUMENT_LOAD_TIMEOUT_MS);
		return () => { dispose(); if (frameLifecycle.current === lifecycle) frameLifecycle.current = null; };
	}, [view.id, view.url, token, automatic]);

	// Explicit context updates reuse the document, preserving form edits and local component state.
	useEffect(() => {
		if (!ready) return;
		const pushContext = () => {
			iframe.current?.contentWindow?.postMessage({ channel: RESOURCE_FRAME_CHANNEL, token, type: "context", context: latest.current.context, language: latest.current.lang, theme: collectTheme(iframe.current?.parentElement) }, "*");
		};
		pushContext();
		if (typeof MutationObserver !== "function") return;
		window.addEventListener("resize", pushContext);
		const observer = new MutationObserver(pushContext);
		const targets = new Set<Element>([document.documentElement]);
		if (document.body) targets.add(document.body);
		if (iframe.current?.parentElement) targets.add(iframe.current.parentElement);
		for (const target of targets) observer.observe(target, { attributes: true, attributeFilter: ["class", "style", "data-theme", "data-ds-dark-theme", "data-pebrel-theme"] });
		return () => { observer.disconnect(); window.removeEventListener("resize", pushContext); };
	}, [context, lang, ready, token]);

	if ((failed || !safeResourceViewUrl(view.url)) && automatic) return null;
	if (failed || !safeResourceViewUrl(view.url)) return <div role="status" className="flex flex-col gap-2 p-3">
		<span>{text.frameFailed}</span>
		{safeResourceViewUrl(view.url) && <button type="button" className="btn-outline" onClick={onRetry}>{text.retry}</button>}
		{onUnavailable && <button type="button" className="btn-outline" onClick={() => callbacks.current.onUnavailable?.()}>{text.basicInterface}</button>}
	</div>;
	const isPanel = view.placement === "panel";
	const isEmbedded = view.placement === "aboveEditor" || view.placement === "belowEditor";
	return <iframe key={`${view.id}:${view.url}`} ref={iframe} src={view.url} title={view.title} sandbox="allow-scripts" referrerPolicy="no-referrer"
		className={isPanel ? "min-h-full w-full flex-1 rounded-lg" : isEmbedded ? "block w-full" : "w-full rounded-lg"}
		aria-hidden={automatic && height === 0 ? true : undefined} tabIndex={automatic && height === 0 ? -1 : undefined}
		style={isPanel ? { minHeight: height, border: 0, background: "transparent" } : { height, border: 0, background: "transparent" }}
		onLoad={() => { if (documentState.current !== "failed") { documentState.current = "loaded"; frameLifecycle.current?.loaded(); } }}
		onErrorCapture={() => { documentState.current = "failed"; if (frameLifecycle.current) frameLifecycle.current.fail(); else setFailed(true); }} />;
}
