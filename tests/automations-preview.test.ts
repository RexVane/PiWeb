import { afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/automations/preview/route";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
const request = (body: unknown) => new Request("http://localhost/api/automations/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

describe("automation schedule preview", () => {
	it("uses the server clock and server time zone across a daylight-saving transition", async () => {
		vi.stubEnv("TZ", "America/New_York");
		const now = Date.parse("2026-03-07T15:00:00Z");
		vi.spyOn(Date, "now").mockReturnValue(now);
		const response = await POST(request({ schedule: { kind: "daily", time: "09:00" } }));
		expect(response.status).toBe(200);
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		expect(await response.json()).toEqual({ success: true, data: { computedAt: now, nextRunAt: Date.parse("2026-03-08T13:00:00Z"), timeZone: "America/New_York" } });
	});

	it.each([null, [], {}, { schedule: { kind: "daily", time: "25:00" } }, { schedule: { kind: "interval", every: 1 } }])("rejects invalid preview request %j", async (body) => {
		expect((await POST(request(body))).status).toBe(400);
	});
});
