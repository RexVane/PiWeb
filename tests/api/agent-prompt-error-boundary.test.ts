import { beforeEach, expect, it, vi } from "vitest";
const deps = vi.hoisted(() => ({ create: vi.fn(), resources: vi.fn(), execute: vi.fn(), managed: vi.fn(), list: vi.fn(), read: vi.fn(), resolve: vi.fn() }));
vi.mock("@/lib/agent-manager", () => ({ createNewSession: deps.create, loadWorkspaceResources: deps.resources, execute: deps.execute, getManaged: deps.managed, exportSession: vi.fn() }));
vi.mock("@/lib/prompt-sources", () => ({ listPromptSources: deps.list, readPromptSource: deps.read }));
vi.mock("@/lib/path-security", () => ({ BoundaryError: class BoundaryError extends Error {}, resolveSessionPath: deps.resolve, resolveWorkspacePath: async () => "/private/project" }));
import { BoundaryError } from "@/lib/path-security";
import { POST as create } from "@/app/api/agent/new/route";
import { GET as resources } from "@/app/api/agent/resources/route";
import { POST as command } from "@/app/api/agent/[id]/route";
import { GET as tree } from "@/app/api/agent/[id]/tree/route";
import { GET as exportSession } from "@/app/api/sessions/[id]/export/route";
import { GET as sources, POST as prompt } from "@/app/api/prompts/route";
const context = () => ({ params: Promise.resolve({ id: "probe" }) });
const get = (path: string) => new Request("http://localhost/api/" + path);
const post = (path: string, data: unknown) => new Request("http://localhost/api/" + path, { method: "POST", body: JSON.stringify(data) });
beforeEach(() => {
	vi.resetAllMocks();
	deps.resolve.mockResolvedValue("/private/session.jsonl");
	for (const fn of [deps.create, deps.resources, deps.execute, deps.managed, deps.list, deps.read]) fn.mockImplementation(() => { throw Object.assign(new Error("EACCES: C:\\Users\\private\\secrets.json"), { code: "EACCES" }); });
});

it.each([
	["create", () => create(post("agent/new", { cwd: "/project" }))],
	["resources", () => resources(get("agent/resources?cwd=project"))],
	["command", () => command(post("agent/probe", { cmd: "abort" }), context())],
	["tree", () => tree(get("agent/probe/tree"), context())],
	["export", () => exportSession(get("sessions/probe/export"), context())],
	["prompt sources", () => sources(get("prompts?cwd=project"))],
	["prompt body", () => prompt(post("prompts", { action: "read", cwd: "/project", filePath: "AGENTS.md" }))],
] as const)("%s failures preserve OS categories without exposing server paths", async (_name, request) => {
	const response = await request();
	expect(response.status).toBe(500);
	const body = await response.json();
	expect(body).toMatchObject({ success: false, errorCode: "EACCES" });
	expect(JSON.stringify(body)).not.toContain("private");
	expect(response.headers.get("Cache-Control")).toContain("no-store");
});

it("preserves an actionable rejected command while redacting its server path", async () => {
	deps.managed.mockReturnValue({});
	deps.execute.mockResolvedValue({ ok: false, error: "Path escapes workspace: D:\\private\\outside" });
	const response = await command(post("agent/probe", { cmd: "abort" }), context());
	expect(response.status).toBe(400);
	const body = await response.json();
	expect(body.error).toContain("Path escapes workspace");
	expect(body.error).not.toContain("private");
});

it("keeps path validation and malformed JSON as client errors", async () => {
	deps.create.mockImplementation(() => { throw new BoundaryError("Workspace unavailable: /private/project"); });
	const validation = await create(post("agent/new", { cwd: "/project" }));
	expect(validation.status).toBe(400);
	expect(await validation.json()).toMatchObject({ errorCode: "VALIDATION_ERROR" });
	const invalid = await create(new Request("http://localhost/api/agent/new", { method: "POST", body: "{" }));
	expect(invalid.status).toBe(400);
	expect(await invalid.json()).toMatchObject({ errorCode: "INVALID_JSON" });
});

it.each([null, [], 42])("rejects non-object request bodies %s without starting work", async (body) => {
	deps.create.mockReset(); deps.read.mockReset();
	for (const response of [await create(post("agent/new", body)), await prompt(post("prompts", body))]) {
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ errorCode: "VALIDATION_ERROR" });
	}
	expect(deps.create).not.toHaveBeenCalled(); expect(deps.read).not.toHaveBeenCalled();
});
