// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAttentionNotifications } from "@/hooks/useAttentionNotifications";
import type { ExtensionDialog } from "@/hooks/usePiWeb";
import type { WebMessage, WebSnapshot } from "@/lib/types";
import { attentionNotifyEnabled, attentionNotifyPreferred, attentionNotifySupport, requestAttentionPermissionOnce, setAttentionNotify } from "@/lib/attention-notify";

class FakeNotification {
	static permission: NotificationPermission = "granted";
	static requestPermission = vi.fn(async () => FakeNotification.permission);
	static created: FakeNotification[] = [];
	onclick: (() => void) | null = null;
	close = vi.fn();
	constructor(readonly title: string, readonly options: NotificationOptions = {}) {
		FakeNotification.created.push(this);
	}
}

let visibility: DocumentVisibilityState = "hidden";
let focused = false;

const ask = (id: string, question = "要覆盖 README 吗？"): ExtensionDialog => ({
	id, method: "questions", title: "", ts: 1,
	questions: [{ question, header: "覆盖", options: [{ label: "是", description: "" }, { label: "否", description: "" }] }],
});
type Turn = { streaming?: boolean; sessionPath?: string; messages?: WebMessage[] };
type Props = { dialogs: ExtensionDialog[]; title: string; turn?: Turn };
const mount = (dialogs: ExtensionDialog[], title = "整理文档", turn: Turn = {}) =>
	renderHook(({ dialogs, title, turn }: Props) => useAttentionNotifications({
		extensionDialogs: dialogs,
		snapshot: { sessionPath: turn?.sessionPath ?? "/sessions/a.jsonl", isStreaming: turn?.streaming ?? false } as WebSnapshot,
		messages: turn?.messages ?? [],
	}, title), { initialProps: { dialogs, title, turn } as Props });
const reply = (stopReason: string, errorMessage?: string): WebMessage => ({ role: "assistant", content: [], stopReason, errorMessage } as WebMessage);

beforeEach(() => {
	FakeNotification.permission = "granted";
	FakeNotification.created = [];
	FakeNotification.requestPermission.mockClear();
	vi.stubGlobal("Notification", FakeNotification);
	Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
	Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
	vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
	visibility = "hidden";
	focused = false;
	// 不写任何偏好：默认就是开
	localStorage.clear();
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	delete (document as { visibilityState?: unknown }).visibilityState;
	delete (window as { isSecureContext?: unknown }).isSecureContext;
	localStorage.clear();
});

describe("等待确认通知", () => {
	it("用户不在页面上时，新出现的待答对话框弹一条系统通知", () => {
		mount([ask("q1")]);
		expect(FakeNotification.created).toHaveLength(1);
		expect(FakeNotification.created[0].title).toBe("pi 在等你确认");
		expect(FakeNotification.created[0].options.body).toBe("整理文档\n要覆盖 README 吗？");
	});

	it("窗口可见但焦点在别的程序里也提醒", () => {
		visibility = "visible";
		mount([ask("q1")]);
		expect(FakeNotification.created).toHaveLength(1);
	});

	it("扩展对话框用标题当正文，没有文字时给兜底文案", () => {
		mount([{ id: "c1", method: "confirm", title: "删除分支？", ts: 1 }, { id: "c2", method: "input", title: "", ts: 2 }], "");
		expect(FakeNotification.created.map((item) => item.options.body)).toEqual(["删除分支？", "回到 PiWeb 查看"]);
	});

	it("用户正看着页面时不弹，之后离开也不为这一条补弹", () => {
		visibility = "visible";
		focused = true;
		const view = mount([ask("q1")]);
		visibility = "hidden";
		focused = false;
		view.rerender({ dialogs: [ask("q1")], title: "整理文档" });
		expect(FakeNotification.created).toHaveLength(0);
	});

	it("用户关掉了、或浏览器没给权限时不弹", () => {
		localStorage.setItem("piweb.notifyAttention", "0");
		mount([ask("q1")]);
		localStorage.clear();
		FakeNotification.permission = "default";
		mount([ask("q2")]);
		FakeNotification.permission = "denied";
		mount([ask("q3")]);
		expect(FakeNotification.created).toHaveLength(0);
	});

	it("快照重发同一批对话框、会话改名都不重复提醒", () => {
		const view = mount([ask("q1")]);
		view.rerender({ dialogs: [ask("q1")], title: "整理文档" });
		view.rerender({ dialogs: [ask("q1")], title: "新名字" });
		expect(FakeNotification.created).toHaveLength(1);
		view.rerender({ dialogs: [ask("q1"), ask("q2")], title: "新名字" });
		expect(FakeNotification.created).toHaveLength(2);
	});

	it("对话框被答掉、或用户回到页面后收掉通知", () => {
		const view = mount([ask("q1"), ask("q2")]);
		const [first, second] = FakeNotification.created;
		view.rerender({ dialogs: [ask("q2")], title: "整理文档" });
		expect(first.close).toHaveBeenCalled();
		expect(second.close).not.toHaveBeenCalled();
		window.dispatchEvent(new Event("focus"));
		expect(second.close).toHaveBeenCalled();
	});

	it("点通知把窗口叫回前台", () => {
		const focus = vi.spyOn(window, "focus").mockImplementation(() => {});
		mount([ask("q1")]);
		FakeNotification.created[0].onclick?.();
		expect(focus).toHaveBeenCalled();
		expect(FakeNotification.created[0].close).toHaveBeenCalled();
	});

	it("安卓 Chrome 那样构造通知会抛时不影响页面", () => {
		vi.stubGlobal("Notification", Object.assign(function () { throw new TypeError("Illegal constructor"); }, { permission: "granted" }));
		expect(() => mount([ask("q1")])).not.toThrow();
	});
});

describe("完成与出错通知", () => {
	it("用户不在页面上时，这一轮跑完弹一条完成通知", () => {
		const view = mount([], "整理文档", { streaming: true });
		expect(FakeNotification.created).toHaveLength(0);
		view.rerender({ dialogs: [], title: "整理文档", turn: { streaming: false, messages: [reply("stop")] } });
		expect(FakeNotification.created).toHaveLength(1);
		expect(FakeNotification.created[0].title).toBe("pi 已完成");
		expect(FakeNotification.created[0].options.body).toBe("整理文档");
	});

	it("以错误结束时报出错并带上原因", () => {
		const view = mount([], "整理文档", { streaming: true });
		view.rerender({ dialogs: [], title: "整理文档", turn: { streaming: false, messages: [reply("error", "429 rate limited")] } });
		expect(FakeNotification.created[0].title).toBe("pi 运行出错");
		expect(FakeNotification.created[0].options.body).toBe("整理文档\n429 rate limited");
	});

	it("用户自己停止的、或正看着页面时跑完的不提醒", () => {
		const stopped = mount([], "整理文档", { streaming: true });
		stopped.rerender({ dialogs: [], title: "整理文档", turn: { streaming: false, messages: [reply("aborted")] } });
		visibility = "visible";
		focused = true;
		const watched = mount([], "整理文档", { streaming: true });
		watched.rerender({ dialogs: [], title: "整理文档", turn: { streaming: false, messages: [reply("stop")] } });
		expect(FakeNotification.created).toHaveLength(0);
	});

	it("从正在跑的会话切到空闲会话不算跑完", () => {
		const view = mount([], "整理文档", { streaming: true, sessionPath: "/sessions/a.jsonl" });
		view.rerender({ dialogs: [], title: "另一个", turn: { streaming: false, sessionPath: "/sessions/b.jsonl" } });
		expect(FakeNotification.created).toHaveLength(0);
	});

	it("会话又跑起来时收掉上一条完成通知", () => {
		const view = mount([], "整理文档", { streaming: true });
		view.rerender({ dialogs: [], title: "整理文档", turn: { streaming: false, messages: [reply("stop")] } });
		view.rerender({ dialogs: [], title: "整理文档", turn: { streaming: true } });
		expect(FakeNotification.created[0].close).toHaveBeenCalled();
	});

	it("用户关掉了就不提醒", () => {
		localStorage.setItem("piweb.notifyAttention", "0");
		const view = mount([], "整理文档", { streaming: true });
		view.rerender({ dialogs: [], title: "整理文档", turn: { streaming: false, messages: [reply("stop")] } });
		expect(FakeNotification.created).toHaveLength(0);
	});
});

describe("系统通知开关", () => {
	it("默认开启，有浏览器权限就直接生效", () => {
		expect(attentionNotifyPreferred()).toBe(true);
		expect(attentionNotifyEnabled()).toBe(true);
	});

	it("关掉后记住，再打开恢复", async () => {
		expect(await setAttentionNotify(false)).toBe("ok");
		expect(attentionNotifyPreferred()).toBe(false);
		expect(attentionNotifyEnabled()).toBe(false);
		expect(await setAttentionNotify(true)).toBe("ok");
		expect(attentionNotifyEnabled()).toBe(true);
		expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
	});

	it("浏览器还没给权限时，第一次发消息问一次，之后不再问", async () => {
		FakeNotification.permission = "default";
		expect(attentionNotifySupport()).toBe("pending");
		expect(attentionNotifyEnabled()).toBe(false);
		requestAttentionPermissionOnce();
		requestAttentionPermissionOnce();
		expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1);
		FakeNotification.permission = "granted";
		await Promise.resolve();
		expect(attentionNotifyEnabled()).toBe(true);
	});

	it("用户关掉了、已有权限或被拒绝时，发消息不询问", () => {
		requestAttentionPermissionOnce();
		FakeNotification.permission = "denied";
		requestAttentionPermissionOnce();
		FakeNotification.permission = "default";
		localStorage.setItem("piweb.notifyAttention", "0");
		requestAttentionPermissionOnce();
		expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
	});

	it("错过询问后，在设置里重新打开开关会再问", async () => {
		FakeNotification.permission = "default";
		requestAttentionPermissionOnce();
		expect(await setAttentionNotify(true)).toBe("pending");
		FakeNotification.requestPermission.mockImplementationOnce(async () => (FakeNotification.permission = "granted"));
		expect(await setAttentionNotify(true)).toBe("ok");
		expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(3);
		expect(attentionNotifyEnabled()).toBe(true);
	});

	it("浏览器拒绝后报 blocked，不再询问", async () => {
		FakeNotification.permission = "denied";
		expect(await setAttentionNotify(true)).toBe("blocked");
		expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
		expect(attentionNotifyEnabled()).toBe(false);
	});

	it("局域网 http 这类非安全上下文报不支持", async () => {
		Object.defineProperty(window, "isSecureContext", { configurable: true, value: false });
		expect(attentionNotifySupport()).toBe("unsupported");
		expect(await setAttentionNotify(true)).toBe("unsupported");
		requestAttentionPermissionOnce();
		expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
		expect(attentionNotifyEnabled()).toBe(false);
	});
});
