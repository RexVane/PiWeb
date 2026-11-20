import { beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({
	list: vi.fn(), read: vi.fn(), toggle: vi.fn(), preview: vi.fn(), remove: vi.fn(), workspace: vi.fn(async (_value: unknown) => "/workspace"),
}));
vi.mock("@/lib/prompt-templates-service", () => ({ listPromptTemplates: deps.list, readPromptTemplate: deps.read, setPromptTemplateDisabled: deps.toggle, previewDeletePromptTemplate: deps.preview, deletePromptTemplate: deps.remove }));
vi.mock("@/lib/path-security", async () => {
	const { BoundaryError } = await import("@/lib/path-boundary");
	return { BoundaryError, resolveWorkspacePath: deps.workspace };
});
import { GET, POST } from "@/app/api/prompt-templates/route";
import { SettingsWriteBusyError } from "@/lib/settings-write-lock";
import { APP_ROOT } from "@/lib/app-root";

const request = (body: unknown) => new Request("http://localhost/api/prompt-templates", { method: "POST", body: JSON.stringify(body) });
beforeEach(() => {
	vi.clearAllMocks();
	deps.workspace.mockResolvedValue("/workspace");
	deps.list.mockResolvedValue([]); deps.read.mockResolvedValue("# Template"); deps.toggle.mockResolvedValue({ changed: true });
	deps.preview.mockResolvedValue({ removed: "/templates/review.md", link: false }); deps.remove.mockResolvedValue({ removed: "/templates/review.md" });
});

describe("prompt template routes", () => {
	it("resolves workspace and returns a no-store catalog", async () => {
		const response = await GET(new Request("http://localhost/api/prompt-templates?cwd=%2Fproject"));
		expect(deps.workspace).toHaveBeenCalledWith("/project");
		expect(deps.list).toHaveBeenCalledWith("/workspace");
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(await response.json()).toEqual({ success: true, data: { templates: [] } });
	});

	it.each(["read", "toggle", "previewDelete", "delete"])("dispatches %s only after checking the workspace", async (action) => {
		const response = await POST(request({ action, filePath: "/templates/review.md", cwd: "/project", disabled: true, expectedPath: "/templates/review.md" }));
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(deps.workspace).toHaveBeenCalledWith("/project");
		if (action === "read") expect(deps.read).toHaveBeenCalledWith("/templates/review.md", "/workspace");
		if (action === "toggle") expect(deps.toggle).toHaveBeenCalledWith("/templates/review.md", true, "/workspace");
		if (action === "previewDelete") expect(deps.preview).toHaveBeenCalledWith("/templates/review.md", "/workspace");
		if (action === "delete") expect(deps.remove).toHaveBeenCalledWith("/templates/review.md", "/workspace", "/templates/review.md");
	});

	it("uses the application fallback for personal templates without a selected workspace", async () => {
		const response = await POST(request({ action: "toggle", filePath: "/templates/review.md", disabled: false, cwd: "" }));
		expect(response.status).toBe(200);
		expect(deps.workspace).toHaveBeenCalledWith(APP_ROOT);
	});

	it.each([
		null, [], { action: "read" }, { action: "read", filePath: 2 }, { action: "read", filePath: "a", cwd: 1 },
		{ action: "toggle", filePath: "a", disabled: "false" }, { action: "delete", filePath: "a" }, { action: "no-op", filePath: "a" },
	])("rejects invalid payload %j without mutating resources", async (body) => {
		const response = await POST(request(body));
		expect(response.status).toBe(400);
		expect(deps.toggle).not.toHaveBeenCalled(); expect(deps.remove).not.toHaveBeenCalled();
	});

	it("reports invalid JSON and redacts internal OS errors", async () => {
		const invalid = await POST(new Request("http://localhost/api/prompt-templates", { method: "POST", body: "{broken" }));
		expect(invalid.status).toBe(400);
		expect((await invalid.json()).errorCode).toBe("INVALID_JSON");
		deps.read.mockRejectedValueOnce(Object.assign(new Error("EACCES: open /Users/private/secret.md"), { code: "EACCES" }));
		const denied = await POST(request({ action: "read", filePath: "/templates/review.md" }));
		const body = await denied.json();
		expect(body.errorCode).toBe("EACCES");
		expect(JSON.stringify(body)).not.toContain("/Users/private");
	});

	it("returns only the recycled path, not a separate backup", async () => {
		const response = await POST(request({ action: "delete", filePath: "/templates/review.md", expectedPath: "/templates/review.md" }));
		expect(await response.json()).toEqual({ success: true, data: { removed: "/templates/review.md" } });
	});

	it("reports an unavailable system Trash without claiming success or leaking process commands", async () => {
		deps.remove.mockRejectedValueOnce(Object.assign(new Error("osascript failed /Users/private/template.md"), { code: "TRASH_UNAVAILABLE" }));
		const response = await POST(request({ action: "delete", filePath: "/templates/review.md", expectedPath: "/templates/review.md" }));
		expect(response.status).toBe(500);
		const body = await response.json();
		expect(body).toMatchObject({ success: false, errorCode: "TRASH_UNAVAILABLE", error: expect.stringContaining("未执行永久删除") });
		expect(JSON.stringify(body)).not.toContain("/Users/private");
	});

	it("returns retry guidance for a busy settings file", async () => {
		deps.toggle.mockRejectedValueOnce(new SettingsWriteBusyError(2));
		const response = await POST(request({ action: "toggle", filePath: "/templates/review.md", disabled: true }));
		expect(response.status).toBe(409);
		expect(response.headers.get("retry-after")).toBe("2");
	});
});
