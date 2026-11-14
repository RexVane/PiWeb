import { beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({ resolve: vi.fn(), read: vi.fn(), dispose: vi.fn(), remove: vi.fn(), forget: vi.fn(), order: [] as string[] }));
vi.mock("../src/lib/path-security", () => ({ BoundaryError: class BoundaryError extends Error {}, resolveSessionPath: deps.resolve }));
vi.mock("../src/lib/session-reader", () => ({ readSession: deps.read, deleteSession: deps.remove }));
vi.mock("../src/lib/agent-manager", () => ({ disposeSessionPath: deps.dispose }));
vi.mock("../src/lib/workspace-store", () => ({ forgetSession: deps.forget }));
import { BoundaryError } from "../src/lib/path-security";
import { DELETE, GET } from "../src/app/api/sessions/[id]/route";
const request = () => new Request("http://127.0.0.1/api/sessions/abc");
const context = () => ({ params: Promise.resolve({ id: "abc" }) });

beforeEach(() => {
	vi.resetAllMocks(); deps.order = [];
	deps.resolve.mockResolvedValue("/isolated/sessions/abc.jsonl");
	deps.read.mockResolvedValue({ messages: [{ role: "user", text: "hello" }] });
	deps.dispose.mockImplementation(async () => { deps.order.push("dispose"); });
	deps.remove.mockImplementation(async () => { deps.order.push("delete"); });
	deps.forget.mockImplementation(async () => { deps.order.push("forget"); });
});

describe("sessions id route", () => {
	it("reads a cold session without creating an agent", async () => {
		const response = await GET(request(), context());
		expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ success: true, data: { messages: [{ role: "user" }] } });
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		expect(deps.read).toHaveBeenCalledWith("/isolated/sessions/abc.jsonl"); expect(deps.dispose).not.toHaveBeenCalled();
	});
	it("does not disclose local paths in a cold-read error and never caches failures", async () => {
		deps.read.mockRejectedValue(new Error("ENOENT: C:\\private\\sessions\\secret.jsonl"));
		const response = await GET(request(), context());
		expect(response.status).toBe(500);
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		expect(JSON.stringify(await response.json())).not.toContain("private");
	});
	it("awaits disposal before deletion and forgets only after deletion succeeds", async () => {
		let release!: () => void;
		deps.dispose.mockImplementation(() => new Promise<void>((resolve) => { release = () => { deps.order.push("dispose"); resolve(); }; }));
		const pending = DELETE(request(), context());
		await vi.waitFor(() => expect(deps.dispose).toHaveBeenCalled());
		expect(deps.remove).not.toHaveBeenCalled(); release();
		expect((await pending).status).toBe(200);
		expect(deps.resolve).toHaveBeenCalledWith("abc", { allowPending: true });
		expect(deps.order).toEqual(["dispose", "delete", "forget"]);
	});
	it("does not delete or forget when disposal fails", async () => {
		deps.dispose.mockRejectedValue(new Error("still writing"));
		expect((await DELETE(request(), context())).status).toBe(500);
		expect(deps.remove).not.toHaveBeenCalled(); expect(deps.forget).not.toHaveBeenCalled();
	});
	it("keeps metadata when deletion fails", async () => {
		deps.remove.mockRejectedValue(new Error("backup failed"));
		expect((await DELETE(request(), context())).status).toBe(500); expect(deps.forget).not.toHaveBeenCalled();
	});
	it.each([GET, DELETE])("rejects invalid paths before reading or modifying a session", async (route) => {
		deps.resolve.mockRejectedValue(new BoundaryError("invalid session"));
		const response = await route(request(), context());
		expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ success: false });
		expect(deps.read).not.toHaveBeenCalled(); expect(deps.dispose).not.toHaveBeenCalled(); expect(deps.remove).not.toHaveBeenCalled();
	});
});
