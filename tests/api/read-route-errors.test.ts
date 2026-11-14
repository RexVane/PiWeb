import { beforeEach, expect, it, vi } from "vitest";
const deps = vi.hoisted(() => ({ list: vi.fn(), index: vi.fn(), read: vi.fn(), image: vi.fn(), open: vi.fn(), upload: vi.fn(), info: vi.fn(), diff: vi.fn(), show: vi.fn(), sessions: vi.fn(), resolve: vi.fn(), cold: vi.fn(), registry: vi.fn(), add: vi.fn(), recovery: vi.fn() }));
vi.mock("next/server", async (original) => ({ ...(await original<typeof import("next/server")>()), after: () => {} }));
vi.mock("@/lib/files-service", () => ({ listWorkspaceDir: deps.list, listWorkspaceIndex: deps.index, readWorkspaceFile: deps.read, readWorkspaceImage: deps.image, openInEditor: deps.open, saveUploadStream: deps.upload, parseUploadLength: Number }));
vi.mock("@/lib/git-service", () => ({ gitInfo: deps.info, gitDiff: deps.diff, gitShow: deps.show }));
vi.mock("@/lib/session-reader", () => ({ listSessions: deps.sessions, readSession: deps.cold, deleteSession: vi.fn() }));
vi.mock("@/lib/agent-manager", () => ({ activeStatus: () => ({}), warmSessionResources: vi.fn(), disposeSessionPath: vi.fn() }));
vi.mock("@/lib/workspace-store", () => ({ canonicalWorkspacePath: async (cwd: string) => cwd, getWorkspaceRegistry: deps.registry, getWorkspaceRecoveryNotice: deps.recovery, addWorkspace: deps.add,
	forgetSession: vi.fn(), archiveSession: vi.fn(), getPinnedSessions: vi.fn(), getRemovedWorkspaces: vi.fn(), pickFolderNative: vi.fn(), pinSession: vi.fn(), registerCwds: vi.fn(), removeWorkspace: vi.fn(), setAlias: vi.fn(), unpinSession: vi.fn() }));
vi.mock("@/lib/path-security", () => ({ BoundaryError: class BoundaryError extends Error {}, resolveSessionPath: deps.resolve, resolveWorkspacePath: async (cwd: string) => cwd }));
import { BoundaryError } from "@/lib/path-security";
import { GET as files, POST as filePost } from "@/app/api/files/route";
import { GET as git } from "@/app/api/git/route";
import { GET as sessions } from "@/app/api/sessions/route";
import { GET as cold } from "@/app/api/sessions/[id]/route";
import { GET as workspaces, POST as workspacePost } from "@/app/api/workspaces/route";
beforeEach(() => {
	vi.resetAllMocks();
	for (const fn of [deps.list, deps.index, deps.read, deps.open, deps.info, deps.diff, deps.show, deps.cold]) fn.mockResolvedValue({});
	deps.image.mockResolvedValue({ bytes: Buffer.from([1]), mimeType: "image/png" });
	deps.sessions.mockResolvedValue([]); deps.resolve.mockResolvedValue("/private/session.jsonl");
	deps.registry.mockResolvedValue({ workspaces: [], aliases: {}, archivedSessions: [], pinnedSessions: [], removedWorkspaces: [] });
	deps.add.mockResolvedValue({ workspaces: ["project"], removedWorkspaces: [] });
	deps.recovery.mockResolvedValue({});
});
it.each([
	["files?cwd=x", files], ["files?read=1&cwd=x", files], ["files?index=1&cwd=x", files], ["files?image=1&cwd=x", files],
	["git?cwd=x", git], ["git?cwd=x&diff=a", git], ["git?cwd=x&show=a", git],
] as const)("private %s response is never stored", async (path, route) => {
	const response = await route(new Request("http://local/api/" + path));
	expect(response.status).toBe(200); expect(response.headers.get("Cache-Control")).toContain("no-store");
});
it("session list retains private ETag revalidation while cold history is never stored", async () => {
	const first = await sessions(new Request("http://local/api/sessions"));
	expect(first.headers.get("Cache-Control")).toBe("private, no-cache");
	const repeat = await sessions(new Request("http://local/api/sessions", { headers: { "if-none-match": first.headers.get("ETag")! } }));
	expect(repeat.status).toBe(304);
	expect((await cold(new Request("http://local/api/sessions/x"), { params: Promise.resolve({ id: "x" }) })).headers.get("Cache-Control")).toBe("no-store");
});
it.each([["files?read=1", files, deps.read], ["git", git, deps.info], ["sessions", sessions, deps.sessions]] as const)("a failed %s response hides server paths but preserves OS classification", async (path, route, mock) => {
	mock.mockRejectedValue(Object.assign(new Error("EACCES: open C:\\Users\\private\\secrets"), { code: "EACCES" }));
	const response = await route(new Request("http://local/api/" + path));
	const result = await response.json();
	expect(response.status).toBe(500); expect(result.errorCode).toBe("EACCES");
	expect(JSON.stringify(result)).not.toContain("private"); expect(response.headers.get("Cache-Control")).toContain("no-store");
});
it("boundary validation preserves its actionable reason and removes server paths", async () => {
	deps.read.mockRejectedValue(new BoundaryError("Path escapes workspace: C:\\private\\root"));
	const response = await files(new Request("http://local/api/files?read=1"));
	const result = await response.json();
	expect(response.status).toBe(400); expect(result.error).toContain("Path escapes workspace");
	expect(result.errorCode).toBe("VALIDATION_ERROR"); expect(result.error).not.toContain("private");
});
it("malformed file actions are classified as invalid JSON rather than an internal failure", async () => {
	const response = await filePost(new Request("http://local/api/files", { method: "POST", body: "{" }));
	expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ errorCode: "INVALID_JSON" });
	expect(response.headers.get("Cache-Control")).toContain("no-store");
});

it("workspace responses hide internal paths and are never stored on success or failure", async () => {
	expect((await workspaces()).headers.get("Cache-Control")).toContain("no-store");
	deps.registry.mockRejectedValue(Object.assign(new Error("EACCES C:\\private\\records"), { code: "EACCES" }));
	const response = await workspaces();
	expect(response.status).toBe(500);
	expect(await response.json()).toMatchObject({ success: false, errorCode: "EACCES" });
	expect(response.headers.get("Cache-Control")).toContain("no-store");
});

it("the workspace mutation response immediately reports persisted recovery information", async () => {
	const notice = { warning: "原有别名、归档和置顶尚未恢复", recovery: { source: "empty", backup: "registry-copy.json" } };
	deps.recovery.mockResolvedValue(notice);
	const response = await workspacePost(new Request("http://local/api/workspaces", { method: "POST", body: JSON.stringify({ action: "add", path: "project" }) }));
	expect(response.status).toBe(200);
	expect(await response.json()).toMatchObject({ success: true, data: { workspaces: ["project"], ...notice } });
	expect(response.headers.get("Cache-Control")).toContain("no-store");
});

it.each(["{", "null", "[]", '{"action":"add","path":42}', '{"action":"registerCwds","cwds":[null]}'])("rejects malformed workspace actions %s without mutation", async (body) => {
	const response = await workspacePost(new Request("http://local/api/workspaces", { method: "POST", body }));
	expect(response.status).toBe(400);
	expect(await response.json()).toMatchObject({ errorCode: body === "{" ? "INVALID_JSON" : "VALIDATION_ERROR" });
	expect(response.headers.get("Cache-Control")).toContain("no-store");
	expect(deps.add).not.toHaveBeenCalled();
});
