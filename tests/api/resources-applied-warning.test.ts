import { beforeEach, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({
	toggle: vi.fn(),
	RefreshError: class ResourceRefreshError extends Error {
		readonly applied = true;
		readonly warningCode?: "PACKAGE_TRASH_PENDING";
		constructor(message: string, options?: ErrorOptions & { warningCode?: "PACKAGE_TRASH_PENDING" }) {
			super(message, options);
			this.warningCode = options?.warningCode;
		}
	},
}));
vi.mock("@/lib/plugins-service", () => ({ ResourceRefreshError: deps.RefreshError, toggleResource: deps.toggle }));
vi.mock("@/lib/path-security", () => ({ BoundaryError: class BoundaryError extends Error {}, resolveWorkspacePath: async () => "/workspace", resolveSessionPath: async () => "/session", samePath: () => true }));
vi.mock("@/lib/pi", () => ({ encodeSessionId: (value: string) => value }));
vi.mock("@/lib/resources/discovery", () => ({ discoverResourcePackages: async () => [], resourceViews: async () => [] }));
vi.mock("@/lib/resources/preferences", () => ({ defaultResourceDevelopmentRoot: () => "/development", getResourcePreferences: async () => ({}), saveResourcePreferences: async () => ({}) }));
vi.mock("@/lib/resources/development", () => ({ validateResourceDevelopmentRoot: async (value: string) => value }));
vi.mock("@/lib/resources/catalog", () => ({ readResourceMarket: async () => ({ items: [], warnings: [] }) }));
vi.mock("@/lib/resources/host", () => ({ invokeResourceAction: async () => null, resourceHostStatuses: () => [] }));

import { POST } from "@/app/api/resources/route";

const request = () => new Request("http://local/api/resources", { method: "POST", body: JSON.stringify({ action: "setEnabled", resourceId: "external-fixture", enabled: false, scope: "project", cwd: "/workspace" }) });
beforeEach(() => { deps.toggle.mockReset(); deps.toggle.mockResolvedValue(undefined); });

it("reports successful resource configuration changes", async () => {
	const response = await POST(request());
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({ success: true });
	expect(deps.toggle).toHaveBeenCalledWith("external-fixture", true, "project", "/workspace");
});

it("preserves applied configuration and returns a redacted refresh warning", async () => {
	deps.toggle.mockRejectedValue(new deps.RefreshError("Command failed at C:\\Users\\private\\resource-loader"));
	const response = await POST(request());
	const body = await response.json();
	expect(response.status).toBe(200);
	expect(body).toMatchObject({ success: true, data: { applied: true, warning: expect.stringContaining("已保存") } });
	expect(body.data).not.toHaveProperty("warningCode");
	expect(JSON.stringify(body)).not.toContain("private");
});

it("preserves the existing committed-trash warning code", async () => {
	deps.toggle.mockRejectedValue(new deps.RefreshError("Native cleanup failed at /private/resource", { warningCode: "PACKAGE_TRASH_PENDING" }));
	const response = await POST(request());
	const body = await response.json();
	expect(response.status).toBe(200);
	expect(body).toMatchObject({ success: true, data: { applied: true, warningCode: "PACKAGE_TRASH_PENDING", warning: expect.stringContaining("文件和恢复记录已保留") } });
	expect(JSON.stringify(body)).not.toContain("private");
});

it("keeps actual persistence failures unsuccessful", async () => {
	deps.toggle.mockRejectedValue(Object.assign(new Error("EACCES: open C:\\Users\\private\\settings.json"), { code: "EACCES" }));
	const response = await POST(request());
	const body = await response.json();
	expect(response.status).toBe(400);
	expect(body).toMatchObject({ success: false, errorCode: "EACCES" });
	expect(body).not.toHaveProperty("data");
	expect(JSON.stringify(body)).not.toContain("private");
});

it("keeps invalid requests unsuccessful without attempting configuration writes", async () => {
	const response = await POST(new Request("http://local/api/resources", { method: "POST", body: "{" }));
	expect(response.status).toBe(400);
	expect(await response.json()).toMatchObject({ success: false, errorCode: "INVALID_JSON" });
	expect(deps.toggle).not.toHaveBeenCalled();
});
