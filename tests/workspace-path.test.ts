import { describe, expect, it } from "vitest";
import { canonicalDraftPath, knownWorkspaceCwds, sameWorkspacePath } from "../src/lib/workspace-path";

describe("workspace path helpers", () => {
	it("normalizes separators and Windows case, and rejects non-strings", () => {
		expect(canonicalDraftPath("C:\\Users\\Me\\Repo\\")).toBe("c:/users/me/repo");
		expect(canonicalDraftPath("/home/me/repo/")).toBe("/home/me/repo");
		expect(canonicalDraftPath(undefined)).toBe("");
		expect(canonicalDraftPath(null)).toBe("");
		expect(canonicalDraftPath(42)).toBe("");
		expect(canonicalDraftPath({ cwd: "/x" })).toBe("");
	});

	it("compares only valid paths", () => {
		expect(sameWorkspacePath("C:\\Repo\\", "c:/repo")).toBe(true);
		expect(sameWorkspacePath(undefined, undefined)).toBe(false);
		expect(sameWorkspacePath("/a", 42)).toBe(false);
	});

	it("skips sessions without cwd instead of throwing", () => {
		const result = knownWorkspaceCwds(["/work/a"], [], ["/work/a", undefined, null, 7, { path: "/work/b" }, "/work/b"]);
		expect(result).toEqual(["/work/a", "/work/b"]);
	});

	it("filters removed workspaces and dedupes case-insensitively", () => {
		const result = knownWorkspaceCwds(["C:\\Work\\A", "C:\\Work\\B"], ["c:/work/a"], ["C:\\Work\\B", "/other"]);
		expect(result).toEqual(["C:\\Work\\B", "/other"]);
	});
});
