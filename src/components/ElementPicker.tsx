"use client";

/**
 * 截图上点选元素（B3）：点「选元素」→ 服务端给 pi 的标签页重新截一张图（对话里那张可能已经过时）→
 * 用户在图上点一下 → 服务端取该点元素并定位源码 → 结果作为元素芯片进入当前会话的输入卡。
 * 可以连续点选；完成 / Esc / 点遮罩退出。只操作 pi 已经打开的页面，不导航、不新开标签页。
 */
import { createContext, useContext, useEffect, useRef, useState, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { IconBrowseOutline14 } from "@/components/icons";
import { useI18n } from "@/i18n";
import type { CaptureResult, PickResult } from "@/lib/browser/pick";
import type { DraftElement } from "@/lib/element-draft";

export interface ElementPickApi {
	/** 当前会话 id（/api/browser 的 session） */
	sessionId: string;
	/** 把点选结果加进当前会话的输入卡 */
	onPick: (element: DraftElement) => void;
}

/** AppShell 在会话视图里提供；没有提供时（Hero、测试）不显示「选元素」 */
export const ElementPickContext = createContext<ElementPickApi | null>(null);
export const useElementPick = () => useContext(ElementPickContext);

/** 截图来自 pi 的浏览器工具时才能点选 */
export function isBrowserTool(name: string): boolean {
	return name.toLowerCase().startsWith("browser_");
}

let keySequence = 0;

function toDraftElement(result: PickResult): DraftElement {
	keySequence += 1;
	return {
		key: `${Date.now().toString(36)}-${keySequence}`,
		label: result.element.label,
		selector: result.element.domPath,
		pageUrl: result.element.pageUrl,
		component: result.element.hints.find((hint) => hint.component)?.component,
		locations: result.locations.slice(0, 3).map((location) => ({ path: location.path, line: location.line })),
		crop: result.crop ? { type: "image", data: result.crop.data, mimeType: result.crop.mimeType } : undefined,
	};
}

async function post<T>(body: Record<string, unknown>): Promise<T> {
	const response = await fetch("/api/browser", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
	const json = (await response.json().catch(() => null)) as { success?: boolean; data?: T; error?: string } | null;
	if (!response.ok || !json?.success) throw new Error(json?.error || `HTTP ${response.status}`);
	return json.data as T;
}

type Phase = { kind: "capturing" } | { kind: "ready" } | { kind: "locating" } | { kind: "error"; message: string };
type Picked = { label: string; located: boolean; box: PickResult["element"]["box"] };

const pct = (value: number, total: number) => `${Math.min(100, Math.max(0, (value / total) * 100))}%`;

/** 元素包围盒在截图里可见的那部分（元素可能有一部分在视口外），换成百分比定位 */
function visibleBoxStyle(box: Picked["box"], width: number, height: number) {
	const left = Math.max(0, box.x);
	const top = Math.max(0, box.y);
	const right = Math.min(width, box.x + box.width);
	const bottom = Math.min(height, box.y + box.height);
	return { left: pct(left, width), top: pct(top, height), width: pct(Math.max(0, right - left), width), height: pct(Math.max(0, bottom - top), height) };
}

export function ElementPicker({ api, onClose }: { api: ElementPickApi; onClose: () => void }) {
	const { t } = useI18n();
	const [capture, setCapture] = useState<CaptureResult | null>(null);
	const [phase, setPhase] = useState<Phase>({ kind: "capturing" });
	const [last, setLast] = useState<Picked | null>(null);
	const busy = useRef(false);
	const mounted = useRef(true);

	useEffect(() => {
		mounted.current = true;
		return () => { mounted.current = false; };
	}, []);

	useEffect(() => {
		let cancelled = false;
		post<CaptureResult>({ action: "capture", session: api.sessionId }).then(
			(result) => {
				if (cancelled) return;
				setCapture(result);
				setPhase({ kind: "ready" });
			},
			(error: unknown) => {
				if (!cancelled) setPhase({ kind: "error", message: error instanceof Error ? error.message : String(error) });
			},
		);
		return () => { cancelled = true; };
	}, [api.sessionId]);

	useEffect(() => {
		const onKey = (e: globalThis.KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [onClose]);

	const pick = async (e: MouseEvent<HTMLImageElement>) => {
		e.stopPropagation();
		if (!capture || busy.current) return;
		const rect = e.currentTarget.getBoundingClientRect();
		if (!rect.width || !rect.height) return;
		// 点击位置按显示尺寸换算回页面视口坐标（CSS 像素，保留两位小数）
		const toPage = (offset: number, shown: number, actual: number) => Math.min(actual, Math.max(0, Math.round(((offset * actual) / shown) * 100) / 100));
		const x = toPage(e.clientX - rect.left, rect.width, capture.width);
		const y = toPage(e.clientY - rect.top, rect.height, capture.height);
		busy.current = true;
		setPhase({ kind: "locating" });
		try {
			const result = await post<PickResult>({ action: "pick", session: api.sessionId, x, y });
			api.onPick(toDraftElement(result));
			if (!mounted.current) return;
			setLast({ label: result.element.label, located: result.locations.length > 0, box: result.element.box });
			setPhase({ kind: "ready" });
		} catch (error) {
			if (mounted.current) setPhase({ kind: "error", message: error instanceof Error ? error.message : String(error) });
		} finally {
			busy.current = false;
		}
	};

	const status =
		phase.kind === "capturing" ? t.pickElementCapturing
			: phase.kind === "locating" ? t.pickElementLocating
				: phase.kind === "error" ? t.pickElementFailed.replace("{error}", () => phase.message)
					: last ? (last.located ? t.pickElementAdded : t.pickElementNoSource).replace("{label}", () => last.label)
						: t.pickElementHint;

	return createPortal(
		<div className="pw-zoom pw-pick modal-mask fixed inset-0 z-[120] flex flex-col items-center justify-center gap-3 p-6" role="dialog" aria-label={t.pickElement} onClick={onClose}>
			<div className="pw-pick-bar" onClick={(e) => e.stopPropagation()}>
				<IconBrowseOutline14 size={14} style={{ flex: "none", color: "var(--dsw-accent)" }} />
				<span className="pw-pick-status" role="status" data-phase={phase.kind}>{status}</span>
				<button type="button" className="pw-pick-done" onClick={onClose}>{t.pickElementDone}</button>
			</div>
			{capture && (
				<div className="pw-pick-stage" onClick={(e) => e.stopPropagation()}>
					<img
						src={`data:${capture.image.mimeType};base64,${capture.image.data}`}
						alt={t.pickElement}
						data-busy={phase.kind === "locating" || undefined}
						onClick={(e) => void pick(e)}
					/>
					{last && (
						<div className="pw-pick-box" data-testid="pick-box" style={visibleBoxStyle(last.box, capture.width, capture.height)} />
					)}
				</div>
			)}
		</div>,
		document.body,
	);
}
