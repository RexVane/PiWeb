import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	catalog: vi.fn(), write: vi.fn(), defaults: vi.fn(), resolveWorkspace: vi.fn(),
	BoundaryError: class BoundaryError extends Error {},
	ValidationError: class CustomProvidersValidationError extends Error {},
	ConflictError: class CustomProvidersConflictError extends Error {},
}));
vi.mock("@/lib/agent-manager", () => ({ peekSessionModelRuntime: () => undefined }));
vi.mock("@/lib/path-security", () => ({ BoundaryError: mocks.BoundaryError, resolveWorkspacePath: mocks.resolveWorkspace, resolveSessionPath: vi.fn() }));
vi.mock("@/lib/model-defaults", () => ({ newSessionDefaults: mocks.defaults }));
vi.mock("@/lib/models-service", () => ({
	...Object.fromEntries(["answerLogin", "builtinCatalogModelIds", "cancelLogin", "contextWindowInfo", "discoverModels", "loginState", "providerUsage", "readCustomProviders", "removeApiKey", "setApiKey", "setModelContextWindow", "startLogin"].map((name) => [name, vi.fn()])),
	listModels: mocks.catalog, listModelsForPiWeb: mocks.catalog, listWorkspaceModelsForPiWeb: mocks.catalog,
	writeCustomProviders: mocks.write, CustomProvidersValidationError: mocks.ValidationError, CustomProvidersConflictError: mocks.ConflictError,
}));
import { GET, POST } from "@/app/api/models/route";
import { GET as defaultsGET } from "@/app/api/models/defaults/route";
import { loginState, setApiKey } from "@/lib/models-service";

const privateMessage = "C:\\private-server\\auth.json secret-token npm --config=private-server";
function post(body: unknown) { return POST(new Request("http://localhost/api/models", { method: "POST", body: JSON.stringify(body) })); }
async function safeFailure(response: Response, status: number) {
	expect(response.status).toBe(status);
	expect(response.headers.get("cache-control")).toBe("no-store");
	const result = await response.json();
	expect(result.success).toBe(false);
	expect(JSON.stringify(result)).not.toContain("private-server");
	expect(JSON.stringify(result)).not.toContain("secret-token");
	return result;
}
beforeEach(() => {
	vi.resetAllMocks();
	mocks.catalog.mockResolvedValue({ providers: [], models: [] });
	mocks.resolveWorkspace.mockResolvedValue("/workspace");
	mocks.defaults.mockResolvedValue({ modelThinkingLevels: {} });
});
describe("model API error boundaries", () => {
	it("redacts background authentication failures just like synchronous API errors", async () => {
		vi.mocked(loginState).mockReturnValueOnce({ done: true, prompt: null, notifyLog: [], error: privateMessage });
		const result = await post({ action: "loginState", providerId: "test" });
		const body = await result.json();
		expect(body).toMatchObject({ success: true, data: { done: true, error: expect.stringContaining("重新开始登录") } });
		expect(JSON.stringify(body)).not.toContain("private-server"); expect(JSON.stringify(body)).not.toContain("secret-token");
	});
	it("acknowledges a registered key-login job without waiting for subsequent interaction", async () => {
		vi.mocked(setApiKey).mockResolvedValueOnce(undefined);
		vi.mocked(loginState).mockReturnValueOnce({ done: false, prompt: null, notifyLog: [] });
		const result = await post({ action: "setKey", providerId: "test", apiKey: "test-key" });
		expect(result.status).toBe(202);
		expect(setApiKey).toHaveBeenCalledWith("test", "test-key", { background: true });
		expect(await result.json()).toMatchObject({ success: true, data: { accepted: true, done: false } });
	});
	it("hides catalog internal paths and command details in GET failures", async () => {
		mocks.catalog.mockRejectedValueOnce(new Error(privateMessage));
		expect(await safeFailure(await GET(new Request("http://localhost/api/models")), 500)).toMatchObject({ errorCode: "REQUEST_FAILED", error: expect.stringContaining("重试") });
	});
	it("hides post-save internal details while preserving an OS error category", async () => {
		mocks.write.mockRejectedValueOnce(Object.assign(new Error(privateMessage), { code: "EACCES" }));
		expect(await safeFailure(await post({ action: "saveCustomProviders", content: "{}" }), 500)).toMatchObject({ errorCode: "EACCES" });
	});
	it("keeps revision conflicts distinct and actionable", async () => {
		mocks.write.mockRejectedValueOnce(new mocks.ConflictError(privateMessage));
		expect(await safeFailure(await post({ action: "saveCustomProviders", content: "{}" }), 409)).toMatchObject({ errorCode: "CONFIG_CHANGED", error: expect.stringContaining("重新载入") });
	});
	it("retains validation errors but removes local paths", async () => {
		mocks.write.mockRejectedValueOnce(new mocks.ValidationError("invalid model at C:\\private-server\\models.json"));
		expect(await safeFailure(await post({ action: "saveCustomProviders", content: "{}" }), 400)).toMatchObject({ errorCode: "VALIDATION_ERROR", error: expect.stringContaining("invalid model") });
	});
	it("rejects a null body as noncached validation instead of a 500", async () => {
		expect(await safeFailure(await post(null), 400)).toMatchObject({ errorCode: "VALIDATION_ERROR" });
	});
	it("returns noncached successful catalogs and defaults", async () => {
		for (const response of [await GET(new Request("http://localhost/api/models")), await defaultsGET(new Request("http://localhost/api/models/defaults?cwd=/workspace"))]) {
			expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
		}
	});
	it("hides default lookup internals and preserves workspace validation status", async () => {
		mocks.defaults.mockRejectedValueOnce(new Error(privateMessage));
		expect(await safeFailure(await defaultsGET(new Request("http://localhost/api/models/defaults?cwd=/workspace")), 500)).toMatchObject({ error: expect.stringContaining("重试") });
		mocks.resolveWorkspace.mockRejectedValueOnce(new mocks.BoundaryError("workspace not found C:\\private-server\\workspace"));
		expect(await safeFailure(await defaultsGET(new Request("http://localhost/api/models/defaults?cwd=/workspace")), 400)).toMatchObject({ errorCode: "VALIDATION_ERROR" });
	});
});
