import { beforeEach, expect, it, vi } from "vitest";
const deps = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn(), apply: vi.fn(), applyProxy: vi.fn() }));
vi.mock("@/lib/agent-manager", () => ({ applySettingsToSessions: deps.apply }));
vi.mock("@/lib/pi-settings", async (original) => ({ ...await original<typeof import("@/lib/pi-settings")>(), getPiSettings: deps.get, patchPiSettings: deps.patch }));
vi.mock("@/lib/runtime-proxy", () => ({ applyRuntimeProxy: deps.applyProxy }));
import { PUT, GET } from "@/app/api/pi-settings/route";
import { PiSettingsRefreshError } from "@/lib/pi-settings";
import { SettingsWriteBusyError } from "@/lib/settings-write-lock";
beforeEach(() => {
	vi.resetAllMocks();
	deps.get.mockResolvedValue({ steeringMode: "all" });
	deps.applyProxy.mockReturnValue({ proxy: null, source: "none", supported: true, activeInProcess: true });
});
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
it("applies httpProxy live without requiring a restart", async () => {
	deps.patch.mockResolvedValue({ httpProxy: "http://127.0.0.1:7890" });
	deps.get.mockResolvedValue({ httpProxy: "http://127.0.0.1:7890" });
	deps.applyProxy.mockReturnValue({ proxy: "http://127.0.0.1:7890", source: "settings", supported: true, activeInProcess: true });
	const response = await PUT(new Request("http://local/api/pi-settings", { method: "PUT", body: JSON.stringify({ httpProxy: "http://127.0.0.1:7890" }) }));
	expect(response.status).toBe(200);
	expect(await response.json()).toMatchObject({ success: true, applied: true, restartRequired: false, data: { httpProxy: "http://127.0.0.1:7890" } });
	expect(deps.applyProxy).toHaveBeenCalledWith("http://127.0.0.1:7890");
});
it("falls back to restartRequired with a warning if live proxy apply cannot activate", async () => {
	deps.patch.mockResolvedValue({ httpProxy: "http://127.0.0.1:7890" });
	deps.applyProxy.mockImplementation(() => { throw new Error("C:\\private\\dispatcher"); });
	const response = await PUT(new Request("http://local/api/pi-settings", { method: "PUT", body: JSON.stringify({ httpProxy: "http://127.0.0.1:7890" }) }));
	expect(response.status).toBe(200);
	const body = await response.json();
	expect(body).toMatchObject({ success: true, applied: true, restartRequired: true, warning: expect.stringContaining("重启 PiWeb") });
	expect(JSON.stringify(body)).not.toContain("private");
});

it("masks httpProxy userinfo passwords in GET and PUT echoes", async () => {
	const stored = { httpProxy: "http://proxy-user:proxy-password@127.0.0.1:7890" };
	deps.get.mockResolvedValue({ ...stored, effective: { ...stored } });
	const response = await GET(new Request("http://local/api/pi-settings"));
	expect(response.status).toBe(200);
	const body = await response.json();
	expect(body.data.httpProxy).toBe("http://proxy-user:***@127.0.0.1:7890");
	expect(body.data.effective.httpProxy).toBe("http://proxy-user:***@127.0.0.1:7890");
	expect(JSON.stringify(body)).not.toContain("proxy-password");

	deps.patch.mockResolvedValue({ httpProxy: stored.httpProxy });
	deps.applyProxy.mockReturnValue({ proxy: stored.httpProxy, source: "settings", supported: true, activeInProcess: true });
	const put = await PUT(new Request("http://local/api/pi-settings", { method: "PUT", body: JSON.stringify({ httpProxy: stored.httpProxy }) }));
	const putBody = await put.json();
	expect(putBody.data.httpProxy).toBe("http://proxy-user:***@127.0.0.1:7890");
	expect(JSON.stringify(putBody)).not.toContain("proxy-password");
	// 写入路径仍收到原值（脱敏只发生在回显）
	expect(deps.applyProxy).toHaveBeenCalledWith(stored.httpProxy);
});

it("returns 409 + Retry-After when the settings file write lock stays busy", async () => {
	deps.patch.mockRejectedValue(new SettingsWriteBusyError(2));
	const response = await PUT(new Request("http://local/api/pi-settings", { method: "PUT", body: "{}" }));
	expect(response.status).toBe(409);
	expect(response.headers.get("Retry-After")).toBe("2");
	expect(await response.json()).toMatchObject({ success: false, errorCode: "SETTINGS_BUSY", retryAfterSeconds: 2 });
});
