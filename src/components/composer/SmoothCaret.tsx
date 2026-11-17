"use client";

import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { createCaretMirror } from "@/lib/textarea-caret";
import styles from "./SmoothCaret.module.css";

/** 超过这个长度就交还给原生光标：每次按键都要给镜像排一遍全文，太长不划算。 */
const MAX_TEXT_LENGTH = 20_000;
/** 停手多久后开始闪烁 */
const BLINK_DELAY_MS = 500;

const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * 输入框的滑行光标：隐藏原生光标，叠一个按指数阻尼滑动的自绘光标。
 *
 * 必须和 textarea 放在同一个定位容器里（容器 `position: relative`）。
 * 任何量不出位置的情况都退回原生光标：触屏设备、选中了一段文字、文本过长、
 * 环境不支持排版测量。所以最坏的结果是没有滑行效果，而不是光标丢失。
 */
export function SmoothCaret({ target }: { target: RefObject<HTMLTextAreaElement | null> }) {
	const caretRef = useRef<HTMLDivElement>(null);
	const scheduleRef = useRef<((glide: boolean) => void) | null>(null);

	useEffect(() => {
		const textarea = target.current;
		const caret = caretRef.current;
		if (!textarea || !caret || typeof window.matchMedia !== "function") return;
		const doc = textarea.ownerDocument;
		const finePointer = window.matchMedia("(pointer: fine)");
		const mirror = createCaretMirror(doc);
		let frame = 0;
		let glideNext = true;
		let placed = false;
		let nativeHidden = false;
		let blinkTimer: ReturnType<typeof setTimeout> | null = null;
		let lastTransform = "";

		const release = () => {
			placed = false;
			lastTransform = "";
			caret.removeAttribute("data-visible");
			if (nativeHidden) {
				nativeHidden = false;
				textarea.style.caretColor = "";
			}
		};

		const sync = () => {
			frame = 0;
			const glide = glideNext;
			glideNext = true;
			const start = textarea.selectionStart;
			const eligible = doc.activeElement === textarea
				&& !textarea.disabled
				&& finePointer.matches
				&& start === textarea.selectionEnd
				&& textarea.value.length <= MAX_TEXT_LENGTH;
			const box = eligible ? mirror.measure(textarea, start) : null;
			if (!box) {
				release();
				return;
			}
			if (!nativeHidden) {
				nativeHidden = true;
				textarea.style.caretColor = "transparent";
			}
			const top = box.y - textarea.scrollTop;
			// 光标被滚出了输入框的可视范围：原生光标此时同样看不见
			if (top + box.height <= 0 || top >= textarea.clientHeight) {
				caret.removeAttribute("data-visible");
				placed = false;
				return;
			}
			// offsetLeft / offsetTop 会取整，弹性布局里输入框常落在小数像素上，光标会偏半个像素；
			// 所以用两个矩形相减取亚像素位置。没有定位容器时才退回取整值。
			let originX = textarea.offsetLeft;
			let originY = textarea.offsetTop;
			const parent = caret.offsetParent;
			if (parent) {
				const own = textarea.getBoundingClientRect();
				const container = parent.getBoundingClientRect();
				originX = own.left - container.left - parent.clientLeft;
				originY = own.top - container.top - parent.clientTop;
			}
			const x = originX + textarea.clientLeft + box.x - textarea.scrollLeft - 0.5;
			const y = originY + textarea.clientTop + top;
			const transform = `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0)`;
			caret.style.height = `${box.height}px`;
			if (transform !== lastTransform) {
				const jump = !placed || !glide;
				if (jump) caret.setAttribute("data-jump", "");
				caret.style.transform = transform;
				if (jump) {
					// 让浏览器先按「无过渡」提交这一次位置，再恢复过渡
					void caret.offsetWidth;
					caret.removeAttribute("data-jump");
				}
				lastTransform = transform;
				caret.setAttribute("data-moving", "");
				if (blinkTimer) clearTimeout(blinkTimer);
				blinkTimer = setTimeout(() => caret.removeAttribute("data-moving"), BLINK_DELAY_MS);
			}
			placed = true;
			caret.setAttribute("data-visible", "");
		};

		const schedule = (glide: boolean) => {
			if (!glide) glideNext = false;
			if (!frame) frame = requestAnimationFrame(sync);
		};
		const glideSoon = () => schedule(true);
		const jumpSoon = () => schedule(false);
		// 失焦要立刻交还原生光标，不等下一帧
		const onBlur = () => {
			if (frame) cancelAnimationFrame(frame);
			frame = 0;
			release();
		};

		scheduleRef.current = schedule;
		doc.addEventListener("selectionchange", glideSoon);
		for (const type of ["input", "keydown", "pointerdown", "pointerup", "select"] as const) textarea.addEventListener(type, glideSoon);
		textarea.addEventListener("focus", jumpSoon);
		textarea.addEventListener("scroll", jumpSoon, { passive: true });
		textarea.addEventListener("blur", onBlur);
		window.addEventListener("resize", jumpSoon);
		finePointer.addEventListener?.("change", jumpSoon);
		const resizeObserver = typeof ResizeObserver === "function" ? new ResizeObserver(jumpSoon) : null;
		resizeObserver?.observe(textarea);
		schedule(false);

		return () => {
			scheduleRef.current = null;
			if (frame) cancelAnimationFrame(frame);
			if (blinkTimer) clearTimeout(blinkTimer);
			doc.removeEventListener("selectionchange", glideSoon);
			for (const type of ["input", "keydown", "pointerdown", "pointerup", "select"] as const) textarea.removeEventListener(type, glideSoon);
			textarea.removeEventListener("focus", jumpSoon);
			textarea.removeEventListener("scroll", jumpSoon);
			textarea.removeEventListener("blur", onBlur);
			window.removeEventListener("resize", jumpSoon);
			finePointer.removeEventListener?.("change", jumpSoon);
			resizeObserver?.disconnect();
			release();
			mirror.destroy();
		};
	}, [target]);

	// 输入框每次渲染（文字被程序改写、命令 chip 出现导致输入框换行等）都重新对位
	useIsomorphicLayoutEffect(() => {
		scheduleRef.current?.(true);
	});

	return <div ref={caretRef} className={styles.caret} data-smooth-caret="" aria-hidden="true" />;
}
