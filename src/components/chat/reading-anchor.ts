"use client";

import { useEffect, useRef, type RefObject } from "react";

const BEFORE_LAYOUT = "piweb:before-chat-layout";

/** Call before changing the columns, while the currently visible text still has its old geometry. */
export function preserveChatReadingPosition(): void {
	window.dispatchEvent(new Event(BEFORE_LAYOUT));
}

interface ReadingAnchor {
	element?: Element;
	range?: Range;
	top: number;
	bottom: boolean;
	width: number;
	capturedAt: number;
}

export function useChatReadingAnchor(rootRef: RefObject<HTMLElement | null>, scrollRef: RefObject<HTMLElement | null>, shouldPin: () => boolean): void {
	const anchor = useRef<ReadingAnchor | null>(null);
	useEffect(() => {
		const root = rootRef.current;
		const scroller = scrollRef.current;
		if (!root || !scroller) return;
		let frame = 0;
		const restore = () => {
			const saved = anchor.current;
			anchor.current = null;
			if (!saved || Date.now() - saved.capturedAt > 500 || root.getBoundingClientRect().width === saved.width) return;
			if (saved.bottom) {
				scroller.scrollTop = scroller.scrollHeight;
				return;
			}
			const rect = saved.range?.startContainer.isConnected ? saved.range.getBoundingClientRect() : saved.element?.isConnected ? saved.element.getBoundingClientRect() : null;
			if (rect) scroller.scrollTop += rect.top - scroller.getBoundingClientRect().top - saved.top;
		};
		const capture = () => {
			if (frame) cancelAnimationFrame(frame);
			// A new drag frame may arrive before the previous restore frame. Finish it first.
			restore();
			const geometry = { width: root.getBoundingClientRect().width, capturedAt: Date.now() };
			if (shouldPin()) {
				anchor.current = { top: 0, bottom: true, ...geometry };
				return;
			}
			const viewport = scroller.getBoundingClientRect();
			const element = [...scroller.querySelectorAll("p, pre, li, h1, h2, h3, h4, table, [data-role='user']")].find((node) => {
				const rect = node.getBoundingClientRect();
				return rect.bottom > viewport.top + 8 && rect.top < viewport.bottom;
			});
			if (!element) return;
			const rect = element.getBoundingClientRect();
			const x = Math.max(viewport.left + 8, rect.left + 8);
			const y = Math.max(viewport.top + 8, rect.top + 4);
			const range = document.caretRangeFromPoint?.(x, y);
			if (range && scroller.contains(range.startContainer) && range.startContainer.nodeType === Node.TEXT_NODE && range.startOffset < (range.startContainer.textContent?.length ?? 0)) {
				range.setEnd(range.startContainer, range.startOffset + 1);
				anchor.current = { element, range, top: range.getBoundingClientRect().top - viewport.top, bottom: false, ...geometry };
			} else {
				anchor.current = { element, top: rect.top - viewport.top, bottom: false, ...geometry };
			}
		};
		const observer = new ResizeObserver(() => {
			if (!anchor.current) return;
			if (frame) cancelAnimationFrame(frame);
			frame = requestAnimationFrame(() => {
				frame = 0;
				restore();
			});
		});
		observer.observe(root);
		window.addEventListener(BEFORE_LAYOUT, capture);
		return () => {
			observer.disconnect();
			window.removeEventListener(BEFORE_LAYOUT, capture);
			if (frame) cancelAnimationFrame(frame);
		};
	}, [rootRef, scrollRef, shouldPin]);
}
