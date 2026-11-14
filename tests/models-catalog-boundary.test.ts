import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ peek: vi.fn(), global: vi.fn(), picker: vi.fn(), workspace: vi.fn() }));
vi.mock("@/lib/agent-manager", () => ({ peekSessionModelRuntime: mocks.peek }));
vi.mock("@/lib/path-security", async (original) => ({ ...(await original<typeof import("@/lib/path-security")>()), resolveSessionPath: async (id: string) => id }));
vi.mock("@/lib/models-service", async (original) => ({ ...(await original<typeof import("@/lib/models-service")>()), listModels: mocks.global, listModelsForPiWeb: mocks.picker, listWorkspaceModelsForPiWeb: mocks.workspace }));
import { GET } from "@/app/api/models/route";
const roots: string[] = [];
afterEach(async () => { vi.clearAllMocks(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
const catalog = { models: [{ provider: "project", id: "vision", name: "Vision", reasoning: true, thinkingLevels: ["low"], contextWindow: 200000, input: ["text", "image"] }], providers: [{ id: "project", name: "Project", authReady: false, authError: "connection failed", builtIn: false, modelCount: 1 }] };
it("loads a cold session catalog from its own header workspace and returns image/auth failure metadata", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-cold-models-")); roots.push(root);
	const file = path.join(root, "cold.jsonl"); await fs.writeFile(file, JSON.stringify({ type: "session", cwd: root }) + "\n");
	mocks.peek.mockReturnValue(undefined); mocks.workspace.mockResolvedValue(catalog);
	const response = await GET(new Request(`http://localhost/api/models?session=${encodeURIComponent(file)}`));
	expect(response.status).toBe(200); expect(mocks.workspace).toHaveBeenCalledWith(await fs.realpath(root));
	expect(mocks.global).not.toHaveBeenCalled(); expect(mocks.picker).not.toHaveBeenCalled();
	const body = await response.json(); expect(body.data.models[0].input).toEqual(["text", "image"]); expect(body.data.providers[0].authError).toBe("connection failed");
});
it("never silently uses the global catalog for a pending session without its workspace", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-pending-models-")); roots.push(root);
	mocks.peek.mockReturnValue(undefined);
	const response = await GET(new Request(`http://localhost/api/models?session=${encodeURIComponent(path.join(root, "missing.jsonl"))}`));
	expect(response.status).toBe(400); expect(mocks.global).not.toHaveBeenCalled(); expect(mocks.picker).not.toHaveBeenCalled();
});
