/**
 * 繁忙时 Enter 的发送方式：steer（插话，当前工具跑完就送达）/ queue（排队，本轮结束后发送）。
 * 存 localStorage；用 useSyncExternalStore 让输入卡和设置面板同步（改设置立刻反映到提示文案）。
 */
import { useSyncExternalStore } from "react";

export type EnterBehavior = "steer" | "queue";

const KEY = "piweb.enterBehavior";
/** 默认插话：与 pi 终端的 Enter 一致，也是 Claude Code 排队消息「尽快送达」的行为 */
export const DEFAULT_ENTER_BEHAVIOR: EnterBehavior = "steer";
const listeners = new Set<() => void>();

export function getEnterBehavior(): EnterBehavior {
	if (typeof window === "undefined") return DEFAULT_ENTER_BEHAVIOR;
	const v = localStorage.getItem(KEY);
	return v === "queue" || v === "steer" ? v : DEFAULT_ENTER_BEHAVIOR;
}

export function setEnterBehavior(v: EnterBehavior): void {
	localStorage.setItem(KEY, v);
	for (const l of listeners) l();
}

export function otherBehavior(v: EnterBehavior): EnterBehavior {
	return v === "steer" ? "queue" : "steer";
}

function subscribe(l: () => void): () => void {
	listeners.add(l);
	window.addEventListener("storage", l);
	return () => {
		listeners.delete(l);
		window.removeEventListener("storage", l);
	};
}

export function useEnterBehavior(): EnterBehavior {
	return useSyncExternalStore(subscribe, getEnterBehavior, () => DEFAULT_ENTER_BEHAVIOR);
}
