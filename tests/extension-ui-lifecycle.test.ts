import { afterEach, describe, expect, it, vi } from "vitest";
import { createExtensionUiBridge } from "../src/lib/extension-ui";
import type { WebEvent } from "../src/lib/types";

afterEach(() => vi.useRealTimers());

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
