/**
 * 系统通知的开关：pi 等用户回答或批准、一轮跑完或出错，而用户不在这个页面时提醒一声。
 * 默认开启，存 localStorage（每个浏览器各自决定，只记「关掉了」）。真正能不能弹还要看浏览器
 * 给没给通知权限：权限只能由用户操作触发询问，所以第一次发消息时问一次，之后不再主动问。
 */
import { useSyncExternalStore } from "react";
import { safeLocalStorage } from "./browser-storage";

const KEY = "piweb.notifyAttention";
const ASKED_KEY = "piweb.notifyAttentionAsked";
const listeners = new Set<() => void>();

/**
 * pending：浏览器还没问过用户；blocked：用户在浏览器里拒绝过；
 * unsupported：没有通知 API，或不是安全上下文（局域网 http 直连）
 */
export type AttentionNotifySupport = "ok" | "pending" | "blocked" | "unsupported";

export function attentionNotifySupport(): AttentionNotifySupport {
	if (typeof window === "undefined" || typeof Notification === "undefined" || !window.isSecureContext) return "unsupported";
	return Notification.permission === "granted" ? "ok" : Notification.permission === "denied" ? "blocked" : "pending";
}

/** 用户的选择（设置里开关的位置）；没动过就是开 */
export function attentionNotifyPreferred(): boolean {
	return safeLocalStorage.getItem(KEY) !== "0";
}

/** 现在真的会弹：用户没关，且浏览器给了权限 */
export function attentionNotifyEnabled(): boolean {
	return attentionNotifyPreferred() && attentionNotifySupport() === "ok";
}

function changed(): void {
	for (const listener of listeners) listener();
}

async function requestPermission(): Promise<void> {
	safeLocalStorage.setItem(ASKED_KEY, "1");
	await Notification.requestPermission().catch(() => undefined);
}

/** 拨开关。打开时浏览器还没给权限就问一次（必须由点击触发）；返回值不是 ok 说明还弹不了 */
export async function setAttentionNotify(enabled: boolean): Promise<AttentionNotifySupport> {
	if (enabled) safeLocalStorage.removeItem(KEY);
	else safeLocalStorage.setItem(KEY, "0");
	if (enabled && attentionNotifySupport() === "pending") await requestPermission();
	changed();
	return attentionNotifySupport();
}

/**
 * 默认开启靠它拿权限：在用户发消息的那一下调用，浏览器还没问过就问一次。
 * 只问一次——用户关掉询问框后不再打扰，之后要开就去设置里拨开关。
 */
export function requestAttentionPermissionOnce(): void {
	if (!attentionNotifyPreferred() || attentionNotifySupport() !== "pending" || safeLocalStorage.getItem(ASKED_KEY) === "1") return;
	void requestPermission().then(changed);
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	window.addEventListener("storage", listener);
	return () => {
		listeners.delete(listener);
		window.removeEventListener("storage", listener);
	};
}

export function useAttentionNotifyEnabled(): boolean {
	return useSyncExternalStore(subscribe, attentionNotifyEnabled, () => false);
}

export function useAttentionNotifyPreferred(): boolean {
	return useSyncExternalStore(subscribe, attentionNotifyPreferred, () => true);
}
