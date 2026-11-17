"use client";

import { useEffect, useRef } from "react";
import { createCaretMirror, type CaretField } from "@/lib/field-caret";
import styles from "./SmoothCaret.module.css";

/** 超过这个长度就交还给原生光标：每次按键都要给镜像排一遍全文，太长不划算。 */
const MAX_TEXT_LENGTH = 20_000;
/** 停手多久后开始闪烁 */
const BLINK_DELAY_MS = 500;
/** 单字输入时光标落后目标超过这么多像素就直接追上，避免快速连打时越落越远 */
const MAX_TYPING_LAG_PX = 20;
/**
 * 有文本光标且量得准的 input 类型。email、number 等读不到光标位置，checkbox 等没有光标；
 * 密码框显示的是圆点，镜像复刻不出同样的字宽（实测光标会偏出一截），保留原生光标。
 */
const TEXT_INPUT_TYPES = new Set(["text", "search", "url", "tel"]);

function caretField(node: EventTarget | null): CaretField | null {
	if (!(node instanceof Element)) return null;
	if (node.tagName === "TEXTAREA") return node as HTMLTextAreaElement;
	if (node.tagName === "INPUT" && TEXT_INPUT_TYPES.has((node as HTMLInputElement).type)) return node as HTMLInputElement;
	return null;
}

/**
 * 全局滑行光标：整个页面只挂一个。哪个文本输入框获得焦点，就隐藏它的原生光标，
 * 叠一个按指数阻尼滑动的自绘光标——对话输入框、搜索框、设置里的输入框都一样。
 *
 * 任何画不准的情况都交还原生光标：触屏设备、选中了一段文字、只读、文本过长、
 * 量不出位置、光标被别的元素盖住。所以最坏的结果是没有滑行效果，而不是光标丢失。
 */
export function SmoothCaret() {
	const caretRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const caret = caretRef.current;
		if (!caret || typeof window.matchMedia !== "function") return;
		const finePointer = window.matchMedia("(pointer: fine)");
		const mirror = createCaretMirror(document);
		let field: CaretField | null = null;
		let frame = 0;
		let placed = false;
		let lastTransform = "";
		let seenGeometry = "";
		let seenValue: string | null = null;
		let seenStart: number | null = null;
		let seenEnd: number | null = null;
		let hiddenOn: { element: CaretField; inline: string } | null = null;
		let blinkTimer: ReturnType<typeof setTimeout> | null = null;

		const release = () => {
			placed = false;
			lastTransform = "";
			caret.removeAttribute("data-visible");
			if (hiddenOn) {
				hiddenOn.element.style.caretColor = hiddenOn.inline;
				hiddenOn = null;
			}
		};

		const detach = () => {
			if (frame) cancelAnimationFrame(frame);
			frame = 0;
			field = null;
			seenGeometry = "";
			seenValue = null;
			release();
		};

		/** 每帧只读几个属性比对；位置、文字、选区都没变就什么也不做 */
		const tick = () => {
			const element = field;
			if (!element || !element.isConnected || document.activeElement !== element) {
				detach();
				return;
			}
			frame = requestAnimationFrame(tick);
			const start = element.selectionStart;
			const end = element.selectionEnd;
			const value = element.value;
			const rect = element.getBoundingClientRect();
			const geometry = `${rect.left}|${rect.top}|${rect.width}|${rect.height}|${element.scrollLeft}|${element.scrollTop}|${element.disabled}|${element.readOnly}|${finePointer.matches}`;
			const textChanged = value !== seenValue || start !== seenStart || end !== seenEnd;
			if (!textChanged && geometry === seenGeometry) return;
			const previousValue = seenValue;
			seenGeometry = geometry;
			seenValue = value;
			seenStart = start;
			seenEnd = end;

			const eligible = start !== null
				&& start === end
				&& !element.disabled
				&& !element.readOnly
				&& finePointer.matches
				&& value.length <= MAX_TEXT_LENGTH
				// 单行输入框文字超宽后会横向滚动，而浏览器报告的滚动量和实际偏移对不上，量不准
				&& !(element.tagName === "INPUT" && element.scrollWidth > element.clientWidth);
			const box = eligible ? mirror.measure(element, start) : null;
			if (!box) {
				release();
				return;
			}
			const computed = getComputedStyle(element);
			const borderLeft = parseFloat(computed.borderLeftWidth) || 0;
			const borderRight = parseFloat(computed.borderRightWidth) || 0;
			const borderTop = parseFloat(computed.borderTopWidth) || 0;
			const borderBottom = parseFloat(computed.borderBottomWidth) || 0;
			const innerLeft = rect.left + borderLeft;
			const innerRight = rect.right - borderRight;
			const innerTop = rect.top + borderTop;
			const innerBottom = rect.bottom - borderBottom;
			// Chrome 里 input 的 clientLeft 连 padding 一起算（textarea 只算边框），
			// 内容区起点统一按「边框盒 + 边框宽度」算；镜像的 box.x 已经含 padding，不会重复。
			const x = innerLeft + box.x - element.scrollLeft;
			const y = rect.top + element.clientTop + box.y - element.scrollTop;
			// 光标被滚出了输入框的可视范围，或被别的元素盖住：自己画会画到外面去，交还原生
			const inside = y + box.height > innerTop && y < innerBottom && x >= innerLeft - 1 && x <= innerRight + 1;
			const hit = inside && typeof document.elementFromPoint === "function" ? document.elementFromPoint(Math.min(x + 1, innerRight - 1), y + box.height / 2) : null;
			if (!inside || (hit && hit !== element && !element.contains(hit))) {
				release();
				return;
			}
			if (hiddenOn?.element !== element) {
				release();
				hiddenOn = { element, inline: element.style.caretColor };
				element.style.caretColor = "transparent";
			}
			caret.style.background = computed.color;
			caret.style.height = `${box.height}px`;
			const transform = `translate3d(${(x - 0.5).toFixed(2)}px, ${y.toFixed(2)}px, 0)`;
			if (transform !== lastTransform) {
				// 文字或选区变了才滑；只是输入框自己挪了位置（页面滚动、布局变化）就直接跟过去。
				// 删字、清空、粘贴这类整段变化也直接到位：滑过去的话光标会停在文字外面，
				// 看起来就像光标和文字中间空了一截。单字输入仍走滑动，落后太多时直接追上。
				const shrunk = previousValue !== null && value.length < previousValue.length;
				const bulkInsert = previousValue !== null && value.length - previousValue.length > 1;
				let jump = !placed || !textChanged || shrunk || bulkInsert;
				if (!jump && previousValue !== null && value !== previousValue) {
					// 落后上限只管「文字真的变了」的情况；纯选区移动（方向键 / Home / End / 点击）照旧滑过去
					const lag = Math.abs(caret.getBoundingClientRect().left - (x - 0.5));
					jump = lag > MAX_TYPING_LAG_PX;
				}
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

		const attach = (target: EventTarget | null) => {
			const next = caretField(target);
			if (next === field) return;
			detach();
			if (!next) return;
			field = next;
			frame = requestAnimationFrame(tick);
		};
		const onFocusIn = (event: FocusEvent) => attach(event.target);
		// 失焦要立刻交还原生光标，不等下一帧
		const onFocusOut = (event: FocusEvent) => {
			if (event.target === field) detach();
		};

		// 窗口不在前台时聚焦不会派发 focusin：窗口回到前台、选区变化时再对一次
		const recheck = () => attach(document.activeElement);
		document.addEventListener("focusin", onFocusIn);
		document.addEventListener("focusout", onFocusOut);
		document.addEventListener("selectionchange", recheck);
		window.addEventListener("focus", recheck);
		recheck();

		return () => {
			document.removeEventListener("focusin", onFocusIn);
			document.removeEventListener("focusout", onFocusOut);
			document.removeEventListener("selectionchange", recheck);
			window.removeEventListener("focus", recheck);
			if (blinkTimer) clearTimeout(blinkTimer);
			detach();
			mirror.destroy();
		};
	}, []);

	return <div ref={caretRef} className={styles.caret} data-smooth-caret="" aria-hidden="true" />;
}
