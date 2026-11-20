"use client";

import { useEffect, useRef } from "react";
import { useI18n } from "@/i18n";
import { useAttentionNotifyEnabled } from "@/lib/attention-notify";
import type { ExtensionDialog, PiWebState } from "./usePiWeb";

const BODY_LIMIT = 200;

/** 用户是不是正看着这个页面：标签页在后台、或窗口失焦（在别的程序里）都算不在 */
function pageHasAttention(): boolean {
	return document.visibilityState === "visible" && document.hasFocus();
}

function dialogText(dialog: ExtensionDialog): string {
	const text = dialog.title || dialog.message;
	return (text ?? "").trim();
}

function show(title: string, tag: string, lines: Array<string | undefined>): Notification | null {
	try {
		const notification = new Notification(title, { body: lines.filter(Boolean).join("\n").slice(0, BODY_LIMIT), tag });
		notification.onclick = () => {
			window.focus();
			notification.close();
		};
		return notification;
	} catch {
		// 安卓 Chrome 只允许 service worker 发通知，这里直接构造会抛：当作没开
		return null;
	}
}

/**
 * 用户不在页面上时，为当前会话弹系统通知：出现新的待答对话框（选择窗口、权限申请、扩展对话框），
 * 或这一轮跑完 / 出错。点通知回到页面；对话框被答掉、会话又跑起来或用户自己回来了，通知跟着收掉。
 */
export function useAttentionNotifications(state: Pick<PiWebState, "extensionDialogs" | "snapshot" | "messages">, sessionTitle: string): void {
	const { t } = useI18n();
	const enabled = useAttentionNotifyEnabled();
	const dialogs = state.extensionDialogs;
	const sessionPath = state.snapshot?.sessionPath ?? null;
	const streaming = state.snapshot?.isStreaming === true;
	// 正文取触发那一刻的值；会话改名、切语言、来了新消息都不该重跑触发判断
	const latest = useRef({ t, sessionTitle, messages: state.messages });
	latest.current = { t, sessionTitle, messages: state.messages };
	// 见过的对话框不再提醒：刷新、重连、切回会话时快照会把同一批待答请求再发一遍
	const seen = useRef(new Set<string>());
	const shown = useRef(new Map<string, Notification>());
	const turnShown = useRef<Notification | null>(null);
	const previous = useRef<{ sessionPath: string | null; streaming: boolean }>({ sessionPath: null, streaming: false });

	useEffect(() => {
		const pending = new Set(dialogs.map((dialog) => dialog.id));
		for (const [id, notification] of shown.current) {
			if (pending.has(id)) continue;
			notification.close();
			shown.current.delete(id);
		}
		for (const dialog of dialogs) {
			if (seen.current.has(dialog.id)) continue;
			if (!enabled || pageHasAttention()) continue;
			const { t, sessionTitle } = latest.current;
			const notification = show(t.notifyAttentionTitle, `piweb-attention-${dialog.id}`, [sessionTitle, dialogText(dialog) || t.notifyAttentionBody]);
			if (notification) shown.current.set(dialog.id, notification);
		}
		seen.current = pending;
	}, [dialogs, enabled]);

	useEffect(() => {
		const before = previous.current;
		previous.current = { sessionPath, streaming };
		if (streaming) {
			turnShown.current?.close();
			turnShown.current = null;
			return;
		}
		// 换会话时「上一个在跑、这一个空闲」不是跑完
		if (!sessionPath || before.sessionPath !== sessionPath || !before.streaming) return;
		if (!enabled || pageHasAttention()) return;
		const { t, sessionTitle, messages } = latest.current;
		const last = messages[messages.length - 1];
		const stop = last?.role === "assistant" ? last.stopReason : undefined;
		// 用户自己点的停止不用再告诉他一遍
		if (stop === "aborted") return;
		const failed = stop === "error";
		const detail = failed ? last?.errorMessage?.trim() : undefined;
		turnShown.current = show(failed ? t.notifyErrorTitle : t.notifyDoneTitle, `piweb-turn-${sessionPath}`, sessionTitle || detail ? [sessionTitle, detail] : [t.notifyAttentionBody]);
	}, [sessionPath, streaming, enabled]);

	useEffect(() => {
		const clear = () => {
			for (const notification of shown.current.values()) notification.close();
			shown.current.clear();
			turnShown.current?.close();
			turnShown.current = null;
		};
		window.addEventListener("focus", clear);
		return () => {
			window.removeEventListener("focus", clear);
			clear();
		};
	}, []);
}
