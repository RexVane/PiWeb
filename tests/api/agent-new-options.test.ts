import { beforeEach, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({ create: vi.fn(), resolveWorkspace: vi.fn() }));
vi.mock("@/lib/agent-manager", () => ({
	createNewSession: deps.create,
}));
vi.mock("@/lib/path-security", () => ({
	BoundaryError: class BoundaryError extends Error {},
	resolveWorkspacePath: deps.resolveWorkspace,
}));

import { POST as create } from "@/app/api/agent/new/route";

const post = (body: unknown) =>
	new Request("http://localhost/api/agent/new", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});

beforeEach(() => {
	vi.resetAllMocks();
	deps.resolveWorkspace.mockImplementation(async (cwd: unknown) => String(cwd));
	deps.create.mockResolvedValue({ sessionPath: "/sessions/new.jsonl", setupApplied: true });
});

it.each([
	["provider without modelId", { cwd: "/project", provider: "anthropic" }, "请提供完整的模型参数"],
	["modelId without provider", { cwd: "/project", modelId: "claude-sonnet-4" }, "请提供完整的模型参数"],
	["non-string thinking", { cwd: "/project", thinking: 123 }, "请提供有效的思考级别"],
])("rejects %s with 400 before calling createNewSession", async (_name, body, fragment) => {
	const res = await create(post(body));
	expect(res.status).toBe(400);
	const json = await res.json();
	expect(json).toMatchObject({ success: false, errorCode: "VALIDATION_ERROR" });
	expect(String(json.error)).toContain(fragment);
	expect(deps.create).not.toHaveBeenCalled();
});

it("forwards validated creation options and returns setupApplied when configured", async () => {
	const res = await create(post({
		cwd: "/project",
		provider: "openai",
		modelId: "gpt-5",
		thinking: "high",
	}));
	expect(res.status).toBe(200);
	expect(deps.create).toHaveBeenCalledWith("/project", {
		provider: "openai",
		modelId: "gpt-5",
		thinking: "high",
	});
	expect(await res.json()).toEqual({
		success: true,
		data: { sessionPath: "/sessions/new.jsonl", setupApplied: true },
	});
});
