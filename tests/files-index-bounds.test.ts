import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, expect, it } from "vitest";
import { listWorkspaceIndex } from "../src/lib/files-service";
import { recycleFixture } from "./lib/sandbox/fixtures";
let root: string;
beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-index-bounds-"));
	execFileSync("git", ["init", "-q", root], { windowsHide: true });
	await Promise.all(Array.from({ length: 50 }, (_, index) => fs.writeFile(path.join(root, "file-" + String(index).padStart(3, "0") + ".txt"), "x")));
});
afterEach(async () => { await recycleFixture(root); });
it("terminates collection at its path cap and preserves Git source/ignore semantics", async () => {
	await fs.writeFile(path.join(root, ".gitignore"), "ignored.txt\n"); await fs.writeFile(path.join(root, "ignored.txt"), "ignored");
	const result = await listWorkspaceIndex(root, { fileLimit: 3 });
	expect(result.source).toBe("git"); expect(result.truncated).toBe(true); expect(result.files).toHaveLength(3);
	expect(result.files).not.toContain("ignored.txt"); expect(result.warning).toBeUndefined();
});
it("truncates bounded byte collection rather than buffering every Git path", async () => {
	const result = await listWorkspaceIndex(root, { gitMaxBytes: 40 });
	expect(result.source).toBe("git"); expect(result.truncated).toBe(true); expect(result.files.length).toBeLessThan(50);
	expect(result.files.every((file) => /^file-\d{3}\.txt$/.test(file))).toBe(true);
});
it("falls back to bounded disk results with a clear warning when Git times out", async () => {
	const result = await listWorkspaceIndex(root, { gitTimeoutMs: 1 });
	expect(result.source).toBe("disk"); expect(result.truncated).toBe(true); expect(result.warning).toContain(".gitignore");
	expect(result.files).toContain("file-000.txt");
});
