import { describe, expect, it, vi } from "vitest";
import { createExtensionUiBridge } from "../../src/lib/extension-ui";
import type { ResourceUiApi, WebResourceView } from "../../src/lib/resources/protocol";
import type { WebEvent } from "../../src/lib/types";

const view: WebResourceView = { id: "user:example:main", resourceId: "example", scope: "user", title: "My question", placement: "aboveEditor", methods: [], url: "/api/resources/views/abcd/assets/index.html" };
function fixture(headless = false) {
	const events: WebEvent[] = [];
	const bridge = createExtensionUiBridge({ publish: (event) => events.push(event), hasViewers: () => false, isHeadless: () => headless,
		resources: { resolve: async () => view, invoke: async (_id, _action, args) => args } });
	return { events, bridge, api: bridge.uiContext.resources as ResourceUiApi };
}
describe("resource interaction bridge", () => {
	it("allows any enabled resource view, retains an offline request and returns its JSON answer", async () => {
		const { events, bridge, api } = fixture();
		const result = api.request("example", "main", { questions: ["Choose"] });
		await vi.waitFor(() => expect(bridge.getPendingRequests()).toHaveLength(1));
		const [request] = bridge.getPendingRequests();
		expect(request).toMatchObject({ method: "resource", resourceView: view, resourceData: { questions: ["Choose"] } });
		bridge.respond(request.id, { value: '{"selected":"A"}' });
		expect(await result).toEqual({ status: "answered", value: { selected: "A" } });
		expect(events.at(-1)?.type).toBe("extension_ui_resolved");
		bridge.dispose();
	});
	it("reports unavailable in unattended mode rather than approving a request", async () => {
		const { events, bridge, api } = fixture(true);
		expect(await api.request("example", "main", null)).toEqual({ status: "unavailable" });
		expect(events).toMatchObject([{ type: "interaction_unavailable", reason: "headless" }]);
		bridge.dispose();
	});
	it("distinguishes cancellation, abort and timeout", async () => {
		const { bridge, api } = fixture();
		const first = api.request("example", "main", null);
		await vi.waitFor(() => expect(bridge.getPendingRequests()).toHaveLength(1));
		bridge.cancelPending();
		expect(await first).toEqual({ status: "cancelled" });
		const controller = new AbortController();
		const second = api.request("example", "main", null, { signal: controller.signal });
		await vi.waitFor(() => expect(bridge.getPendingRequests()).toHaveLength(1)); controller.abort();
		expect(await second).toEqual({ status: "cancelled" });
		expect(await api.request("example", "main", null, { timeout: 1 })).toEqual({ status: "timeout" });
		bridge.dispose();
	});
	it("validates standard Pi select answers against the original options", async () => {
		const { bridge } = fixture();
		const result = (bridge.uiContext.select as (title: string, options: string[]) => Promise<string | undefined>)("Choose", ["A", "B"]);
		bridge.respond(bridge.getPendingRequests()[0].id, { value: "not displayed" });
		expect(await result).toBeUndefined(); bridge.dispose();
	});
});
