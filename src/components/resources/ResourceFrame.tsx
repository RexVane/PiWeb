"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { clientFetch } from "@/lib/client-fetch";
import { RESOURCE_FRAME_CHANNEL, type JsonValue, type ResourceFrameContext, type ResourceDialogIntent, type WebResourceView } from "@/lib/resources/protocol";
import { resourceFrameMessage, safeResourceViewUrl } from "@/lib/resources/frame-protocol";
import { useI18n } from "@/i18n";
import { useResourceText } from "./text";
import { useResourceNavigation } from "./ResourceNavigation";

const RESOURCE_THEME_PROPERTY = /^--(?:dsw|dsh|pw|isx|ds|font)-/;
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
	return <ResourceFrameBody key={`${props.view.id}:${props.view.url}`} {...props} />;
}

function ResourceFrameBody({ view, cwd, sessionPath, request, data, onAnswer, onCancel, onUnavailable, onBusyChange }: {
	view: WebResourceView; cwd: string; sessionPath?: string; request?: JsonValue; data?: JsonValue;
	onAnswer?: (value: JsonValue) => void; onCancel?: () => void; onUnavailable?: () => void; onBusyChange?: (busy: boolean) => void;
}) {
	const text = useResourceText();
	const navigation = useResourceNavigation();
	const { lang } = useI18n();
	const iframe = useRef<HTMLIFrameElement>(null);
	const [height, setHeight] = useState(260);
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
				send({ type: "context", context: latest.current.context, language: latest.current.lang, theme: collectTheme(iframe.current?.parentElement) });
			} else if (message.type === "resize") setHeight(message.height!);
			else if (message.type === "focus") {
				const frame = iframe.current;
				const focused = document.activeElement;
				const available = !!frame && (!focused || focused === document.body || focused === frame);
				if (available) frame.focus({ preventScroll: true });
				send({ type: "result", id: message.id, value: available && document.activeElement === frame });
			}
			else if (message.type === "answer" && !latest.current.context.preview) callbacks.current.onAnswer?.(message.value ?? null);
			else if (message.type === "cancel") callbacks.current.onCancel?.();
			else if (message.type === "busy" && !latest.current.context.preview) callbacks.current.onBusyChange?.(message.value === true);
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
		return () => { active = false; controller.abort(); clearTimeout(deadline); window.removeEventListener("message", receive); };
	}, [view.id, view.url, token]);

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

	if (failed || !safeResourceViewUrl(view.url)) return <div role="status" className="flex flex-col gap-2 p-3">
		<span>{text.frameFailed}</span>
		{onUnavailable && <button type="button" className="btn-outline" onClick={() => callbacks.current.onUnavailable?.()}>{text.basicInterface}</button>}
	</div>;
	const isPanel = view.placement === "panel";
	const isEmbedded = view.placement === "aboveEditor" || view.placement === "belowEditor";
	return <iframe key={`${view.id}:${view.url}`} ref={iframe} src={view.url} title={view.title} sandbox="allow-scripts" referrerPolicy="no-referrer"
		className={isPanel ? "min-h-full w-full flex-1 rounded-lg" : isEmbedded ? "w-full" : "w-full rounded-lg"}
		style={isPanel ? { minHeight: height, border: 0, background: "transparent" } : { height, border: 0, background: "transparent" }}
		onError={() => setFailed(true)} />;
}
