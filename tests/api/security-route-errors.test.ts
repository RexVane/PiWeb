import { beforeEach, expect, it, vi } from "vitest";
const deps = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), probe: vi.fn(), security: vi.fn(), trust: vi.fn(), realpath: vi.fn(), stat: vi.fn(), readdir: vi.fn() }));
vi.mock("@/lib/sandbox/config", () => ({ readSandboxConfig: deps.read, writeSandboxConfig: deps.write }));
vi.mock("@/lib/sandbox/manager", () => ({ probeSandboxSupport: deps.probe }));
vi.mock("@/lib/security-service", () => ({ getSecurity: deps.security, setProjectTrust: deps.trust }));
vi.mock("@/lib/pi", () => ({ reloadLoader: vi.fn(), setProjectTrust: vi.fn() }));
vi.mock("@/lib/agent-manager", () => ({ reloadSessionsForCwd: vi.fn() }));
vi.mock("@/lib/path-security", () => ({ BoundaryError: class BoundaryError extends Error {}, resolveWorkspacePath: async (cwd: string) => cwd }));
vi.mock("node:fs/promises", async (original) => {
	const actual = await original<typeof import("node:fs/promises")>();
	return { ...actual, default: { ...actual, realpath: deps.realpath, stat: deps.stat, readdir: deps.readdir } };
});
import { BoundaryError } from "@/lib/path-security";
import { GET as sandboxGet, PUT as sandboxPut } from "@/app/api/sandbox/route";
import { GET as securityGet, PUT as securityPut } from "@/app/api/security/route";
import { POST as directoryPost } from "@/app/api/fs/route";

const request = (body: unknown) => new Request("http://local/api", { method: "POST", body: JSON.stringify(body) });
beforeEach(() => {
	vi.resetAllMocks();
	deps.read.mockResolvedValue({ additionalWritableRoots: [] }); deps.write.mockResolvedValue({ additionalWritableRoots: [] });
	deps.probe.mockResolvedValue(true); deps.security.mockResolvedValue({}); deps.trust.mockResolvedValue(undefined);
	deps.realpath.mockResolvedValue("C:\\private\\directory"); deps.stat.mockResolvedValue({ isDirectory: () => true }); deps.readdir.mockResolvedValue([]);
});

it.each([["sandbox", sandboxGet, deps.read], ["security", securityGet, deps.security]] as const)("%s GET hides internal errors and forbids storing success or failure", async (_name, route, mock) => {
	expect((await route()).headers.get("Cache-Control")).toContain("no-store");
	mock.mockRejectedValue(Object.assign(new Error("EACCES: C:\\private\\settings"), { code: "EACCES" }));
	const response = await route(); const body = await response.json();
	expect(response.status).toBe(500); expect(body.errorCode).toBe("EACCES");
	expect(JSON.stringify(body)).not.toContain("private"); expect(response.headers.get("Cache-Control")).toContain("no-store");
});

it.each([["sandbox", sandboxPut, deps.write, {}], ["security", securityPut, deps.trust, { defaultProjectTrust: "ask" }]] as const)("%s PUT distinguishes validation from failed I/O", async (_name, route, mock, input) => {
	mock.mockRejectedValue(new BoundaryError("invalid writable path: C:\\private\\settings"));
	let response = await route(request(input)); let body = await response.json();
	expect(response.status).toBe(400); expect(body.errorCode).toBe("VALIDATION_ERROR"); expect(body.error).not.toContain("private");
	mock.mockRejectedValue(Object.assign(new Error("ENOSPC: C:\\private\\settings"), { code: "ENOSPC" }));
	response = await route(request(input)); body = await response.json();
	expect(response.status).toBe(500); expect(body.errorCode).toBe("ENOSPC"); expect(body.error).not.toContain("private");
	expect(response.headers.get("Cache-Control")).toContain("no-store");
});

it.each([sandboxPut, securityPut, directoryPost])("malformed JSON is a 400 with a safe category", async (route) => {
	const response = await route(new Request("http://local/api", { method: "POST", body: "{" }));
	expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ errorCode: "INVALID_JSON" });
	expect(response.headers.get("Cache-Control")).toContain("no-store");
});

it("directory validation remains actionable while actual read permission and I/O failures are 500", async () => {
	const invalid = await directoryPost(request({ action: "list", path: "relative" }));
	expect(invalid.status).toBe(400); expect(await invalid.json()).toMatchObject({ errorCode: "VALIDATION_ERROR" });
	// The route requires an absolute path; pick a spelling that is absolute on this platform
	// (the mocked realpath/readdir never touches the real filesystem).
	const absoluteDirectory = process.platform === "win32" ? "C:\\directory" : "/private/directory";
	for (const code of ["EACCES", "EIO"]) {
		deps.readdir.mockRejectedValue(Object.assign(new Error(code + " C:\\private\\directory"), { code }));
		const response = await directoryPost(request({ action: "list", path: absoluteDirectory }));
		const body = await response.json();
		expect(response.status).toBe(500); expect(body.errorCode).toBe(code); expect(body.error).not.toContain("private");
		expect(response.headers.get("Cache-Control")).toContain("no-store");
	}
});
