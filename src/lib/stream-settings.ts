/**
 * 流式文字输出偏好：显示样式 / 推进速度 / 打字光标。
 *
 * 存 localStorage（piweb.streamStyle / piweb.streamSpeed / piweb.streamCaret），
 * 模块级订阅：设置面板一改，正在流的那条回答在下一帧就换样式，不必重开会话；
 * 跨标签页由 storage 事件同步。
 *
 * 推进量是纯函数 nextRevealEnd(target, shownLength, settings)：给定目标文本、已显示长度和偏好，
 * 算出这一帧该显示到哪。不变量是「显示内容始终是目标前缀、单调增长、最终追平」——
 * 见 tests/stream-settings.test.ts。
 */

export type StreamStyle = "smooth" | "instant" | "typewriter" | "fade";

export interface StreamSettings {
	/** 文字出现的方式 */
	style: StreamStyle;
	/** 推进速度档位 1..5（3 = 标准） */
	speed: number;
	/** 打字光标：流式期间在文字末尾闪烁 */
	caret: boolean;
}

/** 设置面板里的展示顺序（即时排在最后：它是「不要平滑」的退路） */
export const STREAM_STYLES: readonly StreamStyle[] = ["smooth", "typewriter", "fade", "instant"];
export const STREAM_SPEED_MIN = 1;
export const STREAM_SPEED_MAX = 5;
export const DEFAULT_STREAM_SETTINGS: StreamSettings = { style: "smooth", speed: 3, caret: false };

const KEY = {
	style: "piweb.streamStyle",
	speed: "piweb.streamSpeed",
	caret: "piweb.streamCaret",
} as const;

/** 每帧间隔（约 60fps 起步）：档位越高越密 */
const STEP_MS = [24, 20, 16, 12, 8];
/** 平滑 / 渐显：每帧推进「积压 / 该值」，稳定态延迟约 2~8 帧 */
const SMOOTH_DIVISOR = [8, 6, 4, 3, 2];
/** 平滑 / 渐显：每帧至少推进的字符数，保证收尾时也能走完 */
const SMOOTH_MIN_CHARS = [1, 1, 2, 3, 4];
/** 打字机：每帧固定敲出的字符数 */
const TYPEWRITER_CHARS = [1, 2, 3, 5, 8];
/** 打字机也要有底线：积压超过约 1.5 秒的量就跟着加速，不出现「回答完了字还在爬」 */
const TYPEWRITER_CATCHUP_DIVISOR = 90;

export function isStreamStyle(value: string | null | undefined): value is StreamStyle {
	return value === "smooth" || value === "instant" || value === "typewriter" || value === "fade";
}

export function clampStreamSpeed(value: number): number {
	if (!Number.isFinite(value)) return DEFAULT_STREAM_SETTINGS.speed;
	return Math.max(STREAM_SPEED_MIN, Math.min(STREAM_SPEED_MAX, Math.round(value)));
}

/** 这一档速度下每帧的间隔（毫秒） */
export function streamStepMs(speed: number): number {
	return STEP_MS[clampStreamSpeed(speed) - 1];
}

function readStored(): StreamSettings {
	try {
		const style = localStorage.getItem(KEY.style);
		const speed = Number.parseInt(localStorage.getItem(KEY.speed) ?? "", 10);
		const caret = localStorage.getItem(KEY.caret);
		return {
			style: isStreamStyle(style) ? style : DEFAULT_STREAM_SETTINGS.style,
			speed: Number.isFinite(speed) ? clampStreamSpeed(speed) : DEFAULT_STREAM_SETTINGS.speed,
			caret: caret === null ? DEFAULT_STREAM_SETTINGS.caret : caret === "1" || caret === "true",
		};
	} catch {
		// 隐私模式 / localStorage 不可用：这一份内存偏好照样生效
		return DEFAULT_STREAM_SETTINGS;
	}
}

export function loadStreamSettings(): StreamSettings {
	if (typeof window === "undefined") return DEFAULT_STREAM_SETTINGS;
	return readStored();
}

function persist(settings: StreamSettings): void {
	if (typeof window === "undefined") return;
	try {
		localStorage.setItem(KEY.style, settings.style);
		localStorage.setItem(KEY.speed, String(settings.speed));
		localStorage.setItem(KEY.caret, settings.caret ? "1" : "0");
	} catch {
		/* 配额满 / 被禁用：内存里已经生效 */
	}
}

let cached: StreamSettings | null = null;
const listeners = new Set<() => void>();
let storageBound = false;

/** useSyncExternalStore 的 getSnapshot：同一份引用，只有真改了才换（否则会无限重渲染） */
export function getStreamSettings(): StreamSettings {
	if (!cached) cached = loadStreamSettings();
	return cached;
}

/** 服务端 / 水合首帧没有 localStorage，给默认值 */
export function getServerStreamSettings(): StreamSettings {
	return DEFAULT_STREAM_SETTINGS;
}

function bindStorage(): void {
	if (storageBound || typeof window === "undefined") return;
	storageBound = true;
	window.addEventListener("storage", (event) => {
		if (event.key !== null && event.key !== KEY.style && event.key !== KEY.speed && event.key !== KEY.caret) return;
		cached = loadStreamSettings();
		for (const listener of listeners) listener();
	});
}

export function subscribeStreamSettings(listener: () => void): () => void {
	listeners.add(listener);
	bindStorage();
	return () => {
		listeners.delete(listener);
	};
}

/** 改一项并持久化，返回合并后的完整偏好；正在流的回答下帧就用新值 */
export function setStreamSettings(patch: Partial<StreamSettings>): StreamSettings {
	const current = getStreamSettings();
	const next: StreamSettings = {
		style: isStreamStyle(patch.style) ? patch.style : current.style,
		speed: patch.speed === undefined ? current.speed : clampStreamSpeed(patch.speed),
		caret: patch.caret === undefined ? current.caret : patch.caret === true,
	};
	cached = next;
	persist(next);
	for (const listener of listeners) listener();
	return next;
}

/**
 * 不在 UTF-16 代理对中间切：切在中间会渲染成一个替换字符（半个 emoji）。
 * 端点越界时按文本长度收口。
 */
export function safeSliceEnd(text: string, end: number): number {
	if (end <= 0) return 0;
	if (end >= text.length) return text.length;
	const high = text.charCodeAt(end - 1);
	const low = text.charCodeAt(end);
	if (high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff) return Math.min(end + 1, text.length);
	return end;
}

/**
 * 渐显：只在整词处停 —— 从 end 往回找到最近的分隔符，切在它后面；
 * 这一段里没有分隔符（正在敲的词）就照常长，否则会停在原地走不完。
 */
function snapToWordEnd(target: string, from: number, end: number): number {
	if (end >= target.length) return target.length;
	for (let i = end - 1; i >= from; i -= 1) {
		if (/\s/.test(target[i])) return i + 1;
	}
	return end;
}

/**
 * 这一帧显示到哪个下标（返回值 = 目标文本前缀长度）。
 * - instant：不排队，直接追平；
 * - smooth：自适应 —— 积压越多推得越快，稳定态只落后几帧；
 * - typewriter：固定节奏逐字，但积压过大时跟着加速（上限约 1.5 秒的落后量）；
 * - fade：在 smooth 的基础上按整词推进。
 */
export function nextRevealEnd(target: string, shownLength: number, settings: StreamSettings): number {
	const total = target.length;
	if (settings.style === "instant") return total;
	const backlog = total - shownLength;
	if (backlog <= 0) return total;
	const level = clampStreamSpeed(settings.speed) - 1;
	let end: number;
	if (settings.style === "typewriter") {
		end = shownLength + Math.max(TYPEWRITER_CHARS[level], Math.ceil(backlog / TYPEWRITER_CATCHUP_DIVISOR));
	} else {
		end = shownLength + Math.max(SMOOTH_MIN_CHARS[level], Math.ceil(backlog / SMOOTH_DIVISOR[level]));
	}
	if (end > total) end = total;
	if (settings.style === "fade") end = snapToWordEnd(target, shownLength, end);
	return safeSliceEnd(target, end);
}
