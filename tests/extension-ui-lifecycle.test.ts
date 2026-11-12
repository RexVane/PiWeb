import { afterEach, describe, expect, it, vi } from "vitest";
import { createExtensionUiBridge } from "../src/lib/extension-ui";
import type { WebEvent } from "../src/lib/types";

afterEach(() => vi.useRealTimers());

describe("extension UI theme", () => {
	it("hands extensions a plain-text theme and the noOp setTheme result shape", () => {
		// 回归：uiContext 没有 theme，扩展写 ctx.ui.theme.fg("accent", …) 直接抛 TypeError；
		// setTheme 返回 undefined，读 result.success 的扩展也会出错
		const bridge = createExtensionUiBridge({ publish: () => {}, hasViewers: () => true });
		const theme = bridge.uiContext.theme as { fg(color: string, text: string): string; bold(text: string): string; getFgAnsi(color: string): string; getThinkingBorderColor(level: string): (s: string) => string };
		expect(theme.fg("accent", "ready")).toBe("ready");
		expect(theme.bold("done")).toBe("done");
		expect(theme.getFgAnsi("accent")).toBe("");
		expect(theme.getThinkingBorderColor("high")("│")).toBe("│");
		expect((bridge.uiContext.setTheme as (name: string) => unknown)("dark")).toEqual({ success: false, error: "UI not available" });
		bridge.dispose();
	});
});

describe("extension UI pending lifecycle", () => {
	it("records only active requests and publishes a single resolution", async () => {
		const events: WebEvent[] = [];
		const bridge = createExtensionUiBridge({ publish: (evt) => events.push(evt), hasViewers: () => true });
		const ask = bridge.uiContext.confirm as (title: string, message: string) => Promise<boolean>;
		const answer = ask("Confirm", "Continue?");
		const request = bridge.getPendingRequests()[0];
		expect(request).toMatchObject({ method: "confirm", title: "Confirm" });
		expect(bridge.respond(request.id, { confirmed: true })).toBe(true);
		expect(await answer).toBe(true);
		expect(bridge.getPendingRequests()).toEqual([]);
		expect(bridge.respond(request.id, { confirmed: false })).toBe(false);
		expect(events.filter((evt) => evt.type === "extension_ui_resolved")).toHaveLength(1);
		bridge.dispose();
	});

	it("removes abort listeners and expires requests without leaving stale dialogs", async () => {
		vi.useFakeTimers();
		const events: WebEvent[] = [];
		const bridge = createExtensionUiBridge({ publish: (evt) => events.push(evt), hasViewers: () => true });
		const ask = bridge.uiContext.input as (title: string, placeholder: string, opts: { signal?: AbortSignal; timeout?: number }) => Promise<string | undefined>;
		const controller = new AbortController();
		const remove = vi.spyOn(controller.signal, "removeEventListener");
		const answer = ask("Name", "", { signal: controller.signal, timeout: 20 });
		await vi.advanceTimersByTimeAsync(20);
		expect(await answer).toBeUndefined();
		expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
		expect(bridge.getPendingRequests()).toEqual([]);
		expect(events.at(-1)?.type).toBe("extension_ui_resolved");
		controller.abort();
		expect(await ask("Already aborted", "", { signal: controller.signal })).toBeUndefined();
		expect(bridge.getPendingRequests()).toEqual([]);
		bridge.dispose();
	});

	it("cancels requests on dispose and cannot create new pending work afterwards", async () => {
		const bridge = createExtensionUiBridge({ publish: () => {}, hasViewers: () => true });
		const ask = bridge.uiContext.confirm as (title: string, message: string) => Promise<boolean>;
		const answer = ask("Confirm", "Continue?");
		bridge.dispose();
		expect(await answer).toBe(false);
		expect(await ask("Disposed", "Continue?")).toBe(false);
		expect(bridge.getPendingRequests()).toEqual([]);
	});
});

/**
 * pi 的 RPC 模式支持的界面方法，网页端都得接住：以前 editor / setWidget / setTitle / setEditorText
 * 是空操作，扩展调用后什么都不显示（editor 还会被当成用户取消）。
 */
describe("extension UI methods at RPC-mode parity", () => {
	type Ui = {
		editor(title: string, prefill?: string, opts?: { timeout?: number }): Promise<string | undefined>;
		setWidget(key: string, content: unknown, options?: { placement?: string }): void;
		setTitle(title: string): void;
		setEditorText(text: string): void;
		pasteToEditor(text: string): void;
		setStatus(key: string, text: string | undefined): void;
		getEditorText(): string;
	};
	const make = (hasViewers = true) => {
		const events: WebEvent[] = [];
		const bridge = createExtensionUiBridge({ publish: (evt) => events.push(evt), hasViewers: () => hasViewers });
		return { events, bridge, ui: bridge.uiContext as unknown as Ui };
	};

	it("asks the browser to edit multi-line text and returns what the user submitted", async () => {
		const { bridge, ui } = make();
		const answer = ui.editor("Edit commit message", "feat: draft\n\nbody");
		const request = bridge.getPendingRequests()[0];
		expect(request).toMatchObject({ method: "editor", title: "Edit commit message", prefill: "feat: draft\n\nbody" });
		expect(bridge.respond(request.id, { value: "fix: final" })).toBe(true);
		expect(await answer).toBe("fix: final");
		// 取消 → undefined（与 pi 的语义一致）
		const cancelled = ui.editor("Again");
		bridge.respond(bridge.getPendingRequests()[0].id, { cancelled: true });
		expect(await cancelled).toBeUndefined();
		bridge.dispose();
	});

	it("returns undefined from editor at once when nobody is watching, like pi's noOp context", async () => {
		const { bridge, ui } = make(false);
		expect(await ui.editor("Edit", "prefill")).toBeUndefined();
		expect(bridge.getPendingRequests()).toEqual([]);
		bridge.dispose();
	});

	it("keeps widget lines per key, publishes changes and clears on undefined", () => {
		const { events, bridge, ui } = make();
		ui.setWidget("todo", ["☐ write tests", "☑ ship"]);
		ui.setWidget("plan", ["step 2/5"], { placement: "belowEditor" });
		expect(Object.fromEntries(bridge.widgets)).toEqual({
			todo: { lines: ["☐ write tests", "☑ ship"], placement: "aboveEditor" },
			plan: { lines: ["step 2/5"], placement: "belowEditor" },
		});
		expect(events.at(-1)).toMatchObject({ type: "extension_ui", method: "setWidget", widgetKey: "plan", widgetLines: ["step 2/5"], widgetPlacement: "belowEditor" });
		ui.setWidget("todo", undefined);
		expect([...bridge.widgets.keys()]).toEqual(["plan"]);
		const cleared = events.at(-1);
		expect(cleared).toMatchObject({ type: "extension_ui", method: "setWidget", widgetKey: "todo" });
		expect(cleared && "widgetLines" in cleared ? cleared.widgetLines : undefined).toBeUndefined();
		// 清一个本来就没有的 key 不发事件
		const count = events.length;
		ui.setWidget("missing", undefined);
		expect(events).toHaveLength(count);
		bridge.dispose();
	});

	it("ignores component factories, which need a real terminal, without dropping the text version", () => {
		const { events, bridge, ui } = make();
		ui.setWidget("todo", ["text version"]);
		const count = events.length;
		ui.setWidget("todo", () => ({ render: () => ["component"] }));
		expect(events).toHaveLength(count);
		expect(bridge.widgets.get("todo")).toEqual({ lines: ["text version"], placement: "aboveEditor" });
		bridge.dispose();
	});

	it("bounds widget size and strips ANSI colour codes the browser cannot render", () => {
		const { bridge, ui } = make();
		ui.setWidget("log", [`\u001b[32m● ready\u001b[0m`, ...Array.from({ length: 400 }, (_, index) => `line ${index}`), "x".repeat(5000)]);
		const widget = bridge.widgets.get("log")!;
		expect(widget.lines[0]).toBe("● ready");
		expect(widget.lines).toHaveLength(200);
		ui.setWidget("wide", ["x".repeat(5000)]);
		expect(bridge.widgets.get("wide")!.lines[0]).toHaveLength(2000);
		ui.setStatus("git", `\u001b[1mmain\u001b[22m`);
		expect(bridge.statuses.get("git")).toBe("main");
		bridge.dispose();
	});

	it("carries the window title and editor text to the browser", () => {
		const { events, bridge, ui } = make();
		ui.setTitle("pi · refactor auth");
		expect(bridge.getTitle()).toBe("pi · refactor auth");
		expect(events.at(-1)).toMatchObject({ method: "setTitle", title: "pi · refactor auth" });
		ui.setTitle("   ");
		expect(bridge.getTitle()).toBeUndefined();
		ui.setEditorText("/review src/auth.ts");
		expect(events.at(-1)).toMatchObject({ method: "setEditorText", text: "/review src/auth.ts" });
		// 没有终端粘贴处理：与 RPC 模式一样当成设置输入框文字
		ui.pasteToEditor("pasted");
		expect(events.at(-1)).toMatchObject({ method: "setEditorText", text: "pasted" });
		// 输入框内容在浏览器里，服务端同步读不到
		expect(ui.getEditorText()).toBe("");
		bridge.dispose();
	});
});
