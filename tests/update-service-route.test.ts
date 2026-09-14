import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ activeStatus: vi.fn(), runUpdate: vi.fn(), checkForUpdate: vi.fn() }));
vi.mock("../src/lib/agent-manager", () => ({ activeStatus: mocks.activeStatus }));
vi.mock("../src/lib/update-service", () => ({
	runUpdate: mocks.runUpdate,
	checkForUpdate: mocks.checkForUpdate,
	UpdateBusyError: class UpdateBusyError extends Error {},
}));

import { POST } from "../src/app/api/update/route";

function request(body: unknown) {
	return new Request("http://127.0.0.1/api/update", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.activeStatus.mockReturnValue({});
	mocks.runUpdate.mockResolvedValue({ version: "2.0.0", needsRestart: true, buildDir: ".next-releases/test", buildId: "new" });
	mocks.checkForUpdate.mockResolvedValue({ current: "1.0.0", latest: "2.0.0", canUpdate: true });
});

describe("update API input and maintenance guard", () => {
	it.each([null, [], "piweb", 42, true, {}, { target: "shell", action: "update" }, { target: "pi", action: "install arbitrary" }])("rejects invalid body %j before touching update state", async (body) => {
		const response = await POST(request(body));
		expect(response.status).toBe(400);
		expect((await response.json()).success).toBe(false);
		expect(mocks.runUpdate).not.toHaveBeenCalled();
		expect(mocks.checkForUpdate).not.toHaveBeenCalled();
	});

	it("returns 400 for malformed JSON rather than an internal error", async () => {
		const response = await POST(new Request("http://127.0.0.1/api/update", { method: "POST", body: "{invalid" }));
		expect(response.status).toBe(400);
		expect(mocks.runUpdate).not.toHaveBeenCalled();
	});

	it("refuses updates while any session is streaming without starting a release", async () => {
		mocks.activeStatus.mockReturnValue({ a: { streaming: false }, b: { streaming: true } });
		const response = await POST(request({ target: "piweb", action: "update" }));
		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({ success: false, error: expect.stringContaining("maintenance window") });
		expect(mocks.runUpdate).not.toHaveBeenCalled();
	});

	it("provides a live idle recheck to the service and reports newly started sessions as busy", async () => {
		mocks.activeStatus.mockReturnValueOnce({}).mockReturnValue({ a: { streaming: true } });
		mocks.runUpdate.mockImplementation(async (_target, { assertIdle }) => { await assertIdle(); return {}; });
		const response = await POST(request({ target: "pi", action: "update" }));
		expect(response.status).toBe(409);
		expect((await response.json()).success).toBe(false);
	});

	it("does not mark a failed build successful and returns ready metadata only after completion", async () => {
		mocks.runUpdate.mockRejectedValueOnce(new Error("build failed"));
		const failed = await POST(request({ target: "piweb", action: "update" }));
		expect(failed.status).toBe(500);
		expect(await failed.json()).toEqual({ success: false, error: "build failed" });
		const ready = await POST(request({ target: "piweb", action: "update" }));
		expect(ready.status).toBe(200);
		expect(await ready.json()).toMatchObject({ success: true, data: { needsRestart: true, buildDir: ".next-releases/test", buildId: "new" } });
	});

	it("checks versions without trying to update or interrupt a running session", async () => {
		mocks.activeStatus.mockReturnValue({ a: { streaming: true } });
		const response = await POST(request({ target: "pi", action: "check" }));
		expect(response.status).toBe(200);
		expect(mocks.checkForUpdate).toHaveBeenCalledWith("pi");
		expect(mocks.runUpdate).not.toHaveBeenCalled();
	});
});
