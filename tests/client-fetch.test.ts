import { afterEach, expect, it, vi } from "vitest";
import { clientFetch } from "../src/lib/client-fetch";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
it("cleans up timeout and caller listeners after streamed progress reaches EOF", async () => {
	vi.useFakeTimers();
	const caller = new AbortController();
	const remove = vi.spyOn(caller.signal, "removeEventListener");
	vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("{\"progress\":1}\n")); controller.close(); } }))));
	const response = await clientFetch("http://localhost/api/sessions/import", { method: "POST", signal: caller.signal });
	const reader = response.body!.getReader();
	await reader.read(); expect(vi.getTimerCount()).toBe(1);
	await reader.read(); expect(vi.getTimerCount()).toBe(0);
	expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
});
it("propagates caller cancellation while the response body is still pending", async () => {
	const caller = new AbortController(); let received: AbortSignal | undefined;
	vi.stubGlobal("fetch", vi.fn(async (_input, init) => { received = init.signal; return new Response(new ReadableStream()); }));
	const response = await clientFetch("http://localhost/api/files", { signal: caller.signal });
	caller.abort(); expect(received?.aborted).toBe(true);
	await response.body!.cancel();
});
