/**
 * 流式正文的淡入：给刚到达的文字加一个短淡入，文字不再一批批硬蹦出来。
 *
 * 只是视觉效果——文字到达即进入 DOM，不缓冲、不追赶，显示不会落后于实际到达的内容。
 *
 * 做法：把正文切成「单元」（一个西文词，或一两个中日韩字符），每个单元包一层 span。
 * 单元只会在末尾追加，所以同一个 span 始终对应同一个单元，CSS 动画在它出现时跑一次，
 * 之后重渲染不会重播。哪些单元算「刚到」由 tracker 按到达时间判断。
 */
import type { Element, ElementContent, Root, RootContent } from "hast";

/** 淡入时长；与样式里的动画时长保持一致 */
export const STREAM_FADE_MS = 180;
/** 一段内容首次出现时不超过这么多单元才整体淡入；更长说明它不是新到的（恢复会话、重新挂载） */
const FIRST_RENDER_LIMIT = 24;

const CJK = "\\u2e80-\\u9fff\\uac00-\\ud7af\\uf900-\\ufaff\\uff00-\\uffef";
const UNIT_RE = new RegExp(`\\s*(?:[${CJK}]{1,2}|[^\\s${CJK}]+)\\s*`, "g");
const HAS_INK_RE = /\S/;

/** 记录「什么时候一共有多少个单元」，据此判断哪些单元还在淡入期内。每段流式内容一个。 */
export type StreamFadeTracker = { marks: { at: number; count: number }[] };

export function createStreamFadeTracker(): StreamFadeTracker {
	return { marks: [] };
}

/**
 * 返回「从第几个单元起算刚到」，并记下这次渲染的单元总数。
 * 对同一时刻的重复调用幂等（开发模式下 React 会把渲染跑两遍）。
 */
export function freshUnitsFrom(tracker: StreamFadeTracker, total: number, now: number): number {
	const marks = tracker.marks;
	if (!marks.length) marks.push({ at: Number.NEGATIVE_INFINITY, count: total <= FIRST_RENDER_LIMIT ? 0 : total });
	// 最后一个「已经过了淡入期」的记录之前的单元都已稳定
	let settled = 0;
	for (let i = 1; i < marks.length && marks[i].at <= now - STREAM_FADE_MS; i++) settled = i;
	if (settled > 0) marks.splice(0, settled);
	const last = marks[marks.length - 1];
	if (total > last.count) marks.push({ at: now, count: total });
	// 未闭合的语法闭合后字面符号会消失，单元数可能回退：把记录夹到当前长度
	else if (total < last.count) for (const mark of marks) mark.count = Math.min(mark.count, total);
	return Math.min(marks[0].count, total);
}

type Parent = Root | Element;
type Walk = { index: number; freshFrom: number };

function unitSpan(children: ElementContent[], fresh: boolean): Element {
	return { type: "element", tagName: "span", properties: fresh ? { dataStreamFresh: "" } : {}, children };
}

/** 走一遍树：apply 为 false 时只数单元，为 true 时同时把单元包成 span。两遍的计数规则必须完全一致。 */
function walk(parent: Parent, state: Walk, apply: boolean): void {
	const next: (RootContent | ElementContent)[] = [];
	for (const child of parent.children) {
		if (child.type === "text") {
			// 块级元素之间的换行不是正文：ul、table 里放 span 是非法嵌套
			if (!HAS_INK_RE.test(child.value)) {
				next.push(child);
				continue;
			}
			for (const unit of child.value.match(UNIT_RE) ?? [child.value]) {
				if (apply) next.push(unitSpan([{ type: "text", value: unit }], state.index >= state.freshFrom));
				state.index += 1;
			}
			continue;
		}
		if (child.type !== "element") {
			next.push(child);
			continue;
		}
		if (child.tagName === "pre") {
			// 代码块不做逐字淡入：等宽文本一闪一闪反而乱
			state.index += 1;
			next.push(child);
			continue;
		}
		if (child.tagName === "a" || child.tagName === "code") {
			// 链接和行内代码的渲染组件要拿到纯文本子节点（识别文件路径），所以整体当一个单元，包在外面
			if (apply) next.push(unitSpan([child], state.index >= state.freshFrom));
			state.index += 1;
			continue;
		}
		walk(child, state, apply);
		next.push(child);
	}
	if (apply) parent.children = next as typeof parent.children;
}

/** rehype 插件：给流式正文的每个单元包 span，并给刚到的单元打上 data-stream-fresh。 */
export function rehypeStreamFade(options: { tracker: StreamFadeTracker; now?: () => number }) {
	return (tree: Root) => {
		const counter: Walk = { index: 0, freshFrom: 0 };
		walk(tree, counter, false);
		const now = options.now ? options.now() : performance.now();
		const freshFrom = freshUnitsFrom(options.tracker, counter.index, now);
		walk(tree, { index: 0, freshFrom }, true);
	};
}
