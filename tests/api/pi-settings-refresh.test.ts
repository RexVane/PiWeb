import { beforeEach, expect, it, vi } from "vitest";
const deps = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn(), apply: vi.fn() }));
vi.mock("@/lib/agent-manager", () => ({ applySettingsToSessions: deps.apply }));
vi.mock("@/lib/pi-settings", async (original) => ({ ...await original<typeof import("@/lib/pi-settings")>(), getPiSettings: deps.get, patchPiSettings: deps.patch }));
import { PUT } from "@/app/api/pi-settings/route";
import { PiSettingsRefreshError } from "@/lib/pi-settings";
beforeEach(() => { vi.resetAllMocks(); deps.get.mockResolvedValue({ steeringMode: "all" }); });
it("reports a persisted patch with a warning when active settings refresh fails", async () => {
	deps.patch.mockRejectedValue(new PiSettingsRefreshError({ steeringMode: "all" }, new Error("SDK parse failure")));
	const response = await PUT(new Request("http://local/api/pi-settings?cwd=%2Fproject", { method: "PUT", body: JSON.stringify({ steeringMode: "all" }) }));
	expect(response.status).toBe(200);
	expect(await response.json()).toMatchObject({ success: true, applied: true, warning: expect.stringContaining("已保存"), data: { steeringMode: "all" } });
	expect(deps.apply).toHaveBeenCalledWith({ steeringMode: "all" }, "/project");
	expect(response.headers.get("Cache-Control")).toBe("no-store");
});
it("retains saved status when applying a successful patch to active sessions fails", async () => {
	deps.patch.mockResolvedValue({ steeringMode: "all" });
	deps.apply.mockImplementation(() => { throw new AggregateError([new Error("C:\\private\\runtime")], "could not apply"); });
	const response = await PUT(new Request("http://local/api/pi-settings", { method: "PUT", body: "{}" }));
	expect(response.status).toBe(200);
	expect(await response.json()).toMatchObject({ success: true, applied: true, warning: expect.stringContaining("已保存") });
});
it("separates a later descriptor read failure from the persisted patch", async () => {
	deps.patch.mockResolvedValue({ steeringMode: "all" }); deps.get.mockRejectedValue(new Error("C:\\private\\settings.json"));
	const response = await PUT(new Request("http://local/api/pi-settings", { method: "PUT", body: "{}" }));
	const body = await response.json();
	expect(body).toMatchObject({ success: true, applied: true, warning: expect.stringContaining("无法重新读取"), readError: expect.any(String) });
	expect(JSON.stringify(body)).not.toContain("private");
});
