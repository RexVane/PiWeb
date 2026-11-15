import { beforeEach, describe, expect, it, vi } from "vitest";

// Handler-level coverage for the two read-only routes that had none (audit E4).
// Authentication itself is enforced by src/proxy.ts and covered by proxy-auth tests;
// these cases pin the handlers' success, boundary and degradation contracts.
const deps = vi.hoisted(() => ({ resolve: vi.fn(), repoRoot: vi.fn(), identity: vi.fn(), versions: vi.fn() }));

vi.mock("@/lib/path-security", () => ({
	BoundaryError: class BoundaryError extends Error {},
	resolveWorkspacePath: deps.resolve,
}));
vi.mock("@/lib/git-service", () => ({ repoRoot: deps.repoRoot }));
vi.mock("@/lib/github-identity", () => ({ awaitGithubIdentity: deps.identity }));
vi.mock("@/lib/version", () => ({ getRuntimeVersions: deps.versions }));

import { BoundaryError } from "@/lib/path-security";
import { GET as github } from "@/app/api/github/route";
import { GET as version } from "@/app/api/version/route";

const identity = { login: "octocat", name: "The Octocat", avatar: "data:image/png;base64,AAAA", url: "https://github.com/octocat", repo: "octocat/Hello-World" };

beforeEach(() => {
	vi.resetAllMocks();
	deps.resolve.mockResolvedValue("/workspace/project");
	deps.repoRoot.mockResolvedValue({ root: "/workspace/project" });
	deps.identity.mockResolvedValue(identity);
	deps.versions.mockResolvedValue({ piWeb: "0.3.30", piEngine: "1.5.2" });
});

describe("GET /api/github", () => {
	it("returns the identity resolved for the requested workspace", async () => {
		const response = await github(new Request("http://127.0.0.1:30141/api/github?cwd=%2Fworkspace%2Fproject"));
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ success: true, data: { identity } });
		expect(deps.resolve).toHaveBeenCalledExactlyOnceWith("/workspace/project");
		expect(deps.repoRoot).toHaveBeenCalledExactlyOnceWith("/workspace/project");
		expect(deps.identity).toHaveBeenCalledExactlyOnceWith("/workspace/project");
	});
	it("rejects a missing workspace path as a boundary error instead of guessing a directory", async () => {
		deps.resolve.mockRejectedValue(new BoundaryError("invalid workspace path"));
		const response = await github(new Request("http://127.0.0.1:30141/api/github"));
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ success: false, error: "invalid workspace path" });
		expect(deps.resolve).toHaveBeenCalledExactlyOnceWith(null);
		expect(deps.repoRoot).not.toHaveBeenCalled();
	});
	it("degrades to a null identity outside a git repository", async () => {
		deps.repoRoot.mockResolvedValue({ root: null });
		const response = await github(new Request("http://127.0.0.1:30141/api/github?cwd=%2Fworkspace%2Fproject"));
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ success: true, data: { identity: null } });
		expect(deps.identity).not.toHaveBeenCalled();
	});
	it("keeps the git panel usable when the repository probe fails", async () => {
		deps.repoRoot.mockRejectedValue(Object.assign(new Error("git executable not found"), { code: "ENOENT" }));
		const response = await github(new Request("http://127.0.0.1:30141/api/github?cwd=%2Fworkspace%2Fproject"));
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ success: true, data: { identity: null } });
	});
	it("keeps the git panel usable when the GitHub identity lookup fails", async () => {
		deps.identity.mockRejectedValue(new Error("gh is not logged in"));
		const response = await github(new Request("http://127.0.0.1:30141/api/github?cwd=%2Fworkspace%2Fproject"));
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ success: true, data: { identity: null } });
	});
});

describe("GET /api/version", () => {
	it("reports the PiWeb, Pi engine and Node versions without caching them", async () => {
		const response = await version();
		expect(response.status).toBe(200);
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		expect(await response.json()).toEqual({ success: true, data: { piWeb: "0.3.30", piEngine: "1.5.2", node: process.version } });
		expect(deps.versions).toHaveBeenCalledTimes(1);
	});
	it("fails closed instead of returning undefined versions when the runtime lookup fails", async () => {
		deps.versions.mockRejectedValue(new Error("manifest unavailable"));
		await expect(version()).rejects.toThrow("manifest unavailable");
	});
});
