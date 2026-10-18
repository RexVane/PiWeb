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
