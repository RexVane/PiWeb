import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ resolve: vi.fn(), managed: vi.fn(), history: vi.fn(), image: vi.fn() }));
vi.mock("@/lib/agent-manager", () => ({ getManaged: mocks.managed, getSessionHistory: mocks.history, readSessionImage: mocks.image }));
vi.mock("@/lib/path-security", async (original) => ({ ...(await original<typeof import("@/lib/path-security")>()), resolveSessionPath: mocks.resolve }));
import { GET as history } from "@/app/api/sessions/[id]/history/route";
import { GET as image } from "@/app/api/sessions/[id]/images/route";
import { BoundaryError } from "@/lib/path-security";
afterEach(() => { vi.resetAllMocks(); });
const params = { params: Promise.resolve({ id: "session-id" }) };

it("reads a bounded history page from the validated session without initializing an agent", async () => {
	mocks.resolve.mockResolvedValue("private/session.jsonl"); mocks.managed.mockReturnValue({ marker: "managed" });
	mocks.history.mockReturnValue({ messages: [], total: 900, pageStart: 700, pageEnd: 800, olderBefore: 700, newerAfter: 800 });
	const response = await history(new Request("http://localhost/api/sessions/id/history?before=800&limit=100"), params);
	expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
	expect(mocks.resolve).toHaveBeenCalledWith("session-id");
	expect(mocks.history).toHaveBeenCalledWith({ marker: "managed" }, { before: 800, after: undefined, limit: 100 });
	expect((await response.json()).data.newerAfter).toBe(800);
});
it.each(["before=-1", "before=1&after=2", "after=1.5", "before=9007199254740992", "limit=0", "limit=101"])("rejects invalid pagination before opening the session: %s", async (query) => {
	expect((await history(new Request(`http://localhost/api/sessions/id/history?${query}`), params)).status).toBe(400);
	expect(mocks.managed).not.toHaveBeenCalled(); expect(mocks.resolve).not.toHaveBeenCalled();
});
it("does not expose filesystem paths when history loading fails", async () => {
	mocks.resolve.mockRejectedValue(new Error("EACCES C:/Users/private/session.jsonl"));
	const response = await history(new Request("http://localhost/api/sessions/id/history"), params);
	expect(response.status).toBe(500); expect(await response.text()).not.toContain("C:/Users");
});
it("serves only the selected persisted image with no cache or MIME sniffing", async () => {
	mocks.resolve.mockResolvedValue("private/session.jsonl"); mocks.managed.mockReturnValue({ marker: "managed" });
	mocks.image.mockReturnValue({ data: Buffer.from([1, 2, 3]), mimeType: "image/png" });
	const response = await image(new Request("http://localhost/api/sessions/id/images?entry=entry-id&part=2"), params);
	expect(mocks.image).toHaveBeenCalledWith({ marker: "managed" }, "entry-id", 2);
	expect(response.headers.get("content-type")).toBe("image/png"); expect(response.headers.get("cache-control")).toBe("no-store");
	expect(response.headers.get("x-content-type-options")).toBe("nosniff"); expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1, 2, 3]);
});
it("rejects unsafe response types and invalid references without revealing file paths", async () => {
	mocks.resolve.mockResolvedValue("private/session.jsonl"); mocks.managed.mockReturnValue({}); mocks.image.mockReturnValue({ data: Buffer.from("<script>"), mimeType: "image/svg+xml" });
	expect((await image(new Request("http://localhost/api/sessions/id/images?entry=e&part=0"), params)).status).toBe(400);
	mocks.resolve.mockRejectedValue(new BoundaryError("outside C:/Users/private"));
	expect(await (await image(new Request("http://localhost/api/sessions/id/images?entry=e&part=0"), params)).text()).not.toContain("C:/Users");
});
