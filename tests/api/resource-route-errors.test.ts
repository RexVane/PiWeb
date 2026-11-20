import { beforeEach, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({
	skills: vi.fn(), skillToggle: vi.fn(), skillRead: vi.fn(), skillDelete: vi.fn(), skillPreview: vi.fn(),
	packages: vi.fn(), extensions: vi.fn(), install: vi.fn(), remove: vi.fn(), update: vi.fn(), reload: vi.fn(), togglePackage: vi.fn(), toggleExtension: vi.fn(),
	rounds: vi.fn(), growthRecord: vi.fn(), growthConsent: vi.fn(), resources: vi.fn(), invoke: vi.fn(), scan: vi.fn(), importSessions: vi.fn(),
}));
vi.mock("@/lib/path-security", () => ({ BoundaryError: class BoundaryError extends Error {}, resolveWorkspacePath: async () => "/workspace", resolveSessionPath: async () => "/session" }));
vi.mock("@/lib/pi", () => ({ getAgentDir: () => "/test-agent", encodeSessionId: (value: string) => value }));
vi.mock("@/lib/workspace-store", () => ({ getGrowthInitConsent: async () => true, setGrowthInitConsent: async () => {}, registerCwds: async () => {} }));
vi.mock("@/lib/skills-service", () => ({ listSkills: deps.skills, setSkillDisabled: deps.skillToggle, readSkillFile: deps.skillRead, deleteSkill: deps.skillDelete, previewDeleteSkill: deps.skillPreview }));
vi.mock("@/lib/plugins-service", () => ({
	ExtensionToggleError: class ExtensionToggleError extends Error {}, ResourceRefreshError: class ResourceRefreshError extends Error {},
	listPackages: deps.packages, listLoadedExtensions: deps.extensions, installPackage: deps.install, removePackage: deps.remove,
	updatePackages: deps.update, reloadExtensions: deps.reload, togglePackage: deps.togglePackage, toggleExtension: deps.toggleExtension,
}));
vi.mock("@/lib/growth-service", () => ({ GrowthError: class GrowthError extends Error { constructor(message: string, public code = "failed") { super(message); } }, readRounds: deps.rounds, isAvailable: async () => true, changesBetween: vi.fn(), fileContent: vi.fn(), filePatch: vi.fn(), listTree: vi.fn() }));
vi.mock("@/lib/agent-manager", () => ({ getManaged: () => ({}), growthRecord: deps.growthRecord, growthConsent: deps.growthConsent, updateRecordingForWorkspace: async () => {} }));
vi.mock("@/lib/resources/discovery", () => ({ discoverResourcePackages: deps.resources, resourceViews: async () => [] }));
vi.mock("@/lib/resources/preferences", () => ({ getResourcePreferences: async () => ({ catalogUrls: [], renderers: {} }), saveResourcePreferences: async () => ({}) }));
vi.mock("@/lib/resources/catalog", () => ({ readResourceMarket: async () => ({ items: [], warnings: [] }) }));
vi.mock("@/lib/resources/host", () => ({ invokeResourceAction: deps.invoke, resourceHostStatuses: () => [] }));
vi.mock("@/lib/session-import", () => ({ scanAllSources: deps.scan, importSessions: deps.importSessions }));

import { GET as skillsGet, POST as skillsPost } from "@/app/api/skills/route";
import { GET as pluginsGet, POST as pluginsPost } from "@/app/api/plugins/route";
import { GET as growthGet, POST as growthPost } from "@/app/api/growth/route";
import { GET as resourcesGet, POST as resourcesPost } from "@/app/api/resources/route";
import { GET as importGet, POST as importPost } from "@/app/api/sessions/import/route";
import { ExtensionToggleError, ResourceRefreshError } from "@/lib/plugins-service";
import { GrowthError } from "@/lib/growth-service";

const request = (path: string, body?: unknown) => new Request("http://local/api/" + path, body === undefined ? undefined : { method: "POST", body: JSON.stringify(body) });
const privateError = () => Object.assign(new Error("EACCES: open C:\\Users\\private\\secret.json"), { code: "EACCES" });
beforeEach(() => {
	vi.resetAllMocks(); deps.skills.mockResolvedValue([]); deps.packages.mockResolvedValue([]); deps.extensions.mockResolvedValue([]); deps.resources.mockResolvedValue([]);
	deps.rounds.mockResolvedValue([]); deps.scan.mockResolvedValue({ summaries: [], errors: [], imported: [], archived: [], hasMore: {} });
	deps.importSessions.mockResolvedValue({ imported: 0, restored: 0, skipped: 0, failed: 0, results: [], workspaces: [] });
});

it.each([
	["skills", deps.skills, () => skillsGet(request("skills")), 500],
	["plugins", deps.packages, () => pluginsGet(request("plugins")), 500],
	["growth", deps.rounds, () => growthGet(request("growth")), 500],
	["resources", deps.resources, () => resourcesGet(request("resources")), 500],
	["import scan", deps.scan, () => importGet(request("sessions/import")), 500],
] as const)("hides server paths in failed %s reads and preserves the OS category", async (_name, mock, read, status) => {
	mock.mockRejectedValue(privateError()); const response = await read(); const result = await response.json();
	expect(response.status).toBe(status); expect(result.errorCode).toBe("EACCES");
	expect(result.error).toBe("没有权限访问请求的资源。"); expect(JSON.stringify(result)).not.toContain("private");
});

it.each([
	["skills", deps.skillToggle, () => skillsPost(request("skills", { action: "toggle", filePath: "skill", disabled: true })), 500],
	["plugins", deps.install, () => pluginsPost(request("plugins", { action: "install", source: "npm:plugin" })), 500],
	["growth", deps.growthRecord, () => growthPost(request("growth", { action: "record", session: "session" })), 500],
	["resources", deps.invoke, () => resourcesPost(request("resources", { action: "invoke", resourceId: "third-party", name: "list" })), 400],
	["import", deps.importSessions, () => importPost(request("sessions/import", { sessions: [{ source: "claude", externalId: "one" }] })), 500],
] as const)("hides server paths in failed %s mutations and preserves the OS category", async (_name, mock, mutate, status) => {
	mock.mockRejectedValue(privateError()); const response = await mutate(); const result = await response.json();
	expect(response.status).toBe(status); expect(result.errorCode).toBe("EACCES"); expect(JSON.stringify(result)).not.toContain("private");
});

it.each([["skills", skillsPost], ["plugins", pluginsPost], ["growth", growthPost], ["resources", resourcesPost]] as const)("keeps malformed JSON a 400 for %s", async (path, post) => {
	const response = await post(new Request("http://local/api/" + path, { method: "POST", body: "{" }));
	expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ errorCode: "INVALID_JSON" });
});

it("preserves actionable validation and conflicts while removing paths", async () => {
	deps.toggleExtension.mockRejectedValue(new ExtensionToggleError("Use the whole-package switch at C:\\Users\\private\\plugin"));
	const toggle = await pluginsPost(request("plugins", { action: "toggle", kind: "extension", path: "extension" }));
	expect(toggle.status).toBe(400); expect((await toggle.json()).error).toContain("whole-package");
	deps.growthRecord.mockRejectedValue(new GrowthError("growth requires consent at /private/workspace", "needs-consent"));
	const growth = await growthPost(request("growth", { action: "record", session: "session" }));
	expect(growth.status).toBe(409); expect(await growth.json()).toMatchObject({ errorCode: "GROWTH_NEEDS_CONSENT", error: expect.stringContaining("consent") });
});

it("keeps saved plugin changes successful when refresh fails and redacts its warning", async () => {
	deps.install.mockRejectedValue(new ResourceRefreshError("Command failed: C:\\Users\\private\\plugin-loader"));
	const response = await pluginsPost(request("plugins", { action: "install", source: "npm:plugin" })); const body = await response.json();
	expect(response.status).toBe(200); expect(body).toMatchObject({ success: true, data: { applied: true, warning: expect.stringContaining("已保存") } });
	expect(JSON.stringify(body)).not.toContain("private");
});

it("reports a committed uninstall with pending Trash cleanup without revealing paths", async () => {
	deps.remove.mockRejectedValue(Object.assign(new ResourceRefreshError("native command at /private/installation"), { warningCode: "PACKAGE_TRASH_PENDING" }));
	const response = await pluginsPost(request("plugins", { action: "remove", source: "npm:plugin" }));
	const body = await response.json();
	expect(response.status).toBe(200);
	expect(body).toMatchObject({ success: true, data: { applied: true, warningCode: "PACKAGE_TRASH_PENDING", warning: expect.stringContaining("文件和恢复记录已保留") } });
	expect(JSON.stringify(body)).not.toContain("/private/");
});

it("redacts source scan errors and import diagnostics without hiding intended workspace fields", async () => {
	deps.scan.mockResolvedValue({ summaries: [], imported: [], archived: [], hasMore: {}, errors: [{ source: "claude", message: "Malformed source at /private/source.jsonl" }] });
	const scan = await (await importGet(request("sessions/import"))).json();
	expect(scan.data.errors[0].message).toContain("Malformed source"); expect(JSON.stringify(scan)).not.toContain("private");
	deps.importSessions.mockResolvedValue({ imported: 0, restored: 0, skipped: 0, failed: 1, workspaces: ["/workspace"], results: [{ source: "claude", externalId: "one", status: "failed", workspace: "/workspace", reason: "Malformed source at C:\\Users\\private\\source.jsonl" }] });
	const imported = await (await importPost(request("sessions/import", { sessions: [{ source: "claude", externalId: "one" }] }))).json();
	expect(imported.data.results[0].reason).toContain("Malformed source"); expect(imported.data.workspaces).toEqual(["/workspace"]); expect(JSON.stringify(imported)).not.toContain("private");
});
