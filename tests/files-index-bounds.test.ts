import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const gitScan = vi.hoisted(() => ({ hang: false }));

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		spawn: (command: string, args: readonly string[] = [], options?: import("node:child_process").SpawnOptions) => {
			// Only the index scan of the timeout case is simulated; every other spawn
			// (including the real `git init`/`git ls-files` of the other cases) is the
			// real binary. Relying on wall-clock time for a 1ms budget is inherently
			// racy: fast CI runners finish `git ls-files` before the timer fires.
			if (!gitScan.hang || !Array.isArray(args) || !args.includes("ls-files")) {
				return options ? actual.spawn(command, args, options) : actual.spawn(command, args);
			}
			const child = Object.assign(new EventEmitter(), {
				stdout: new EventEmitter(),
				stderr: new EventEmitter(),
				kill: () => { setImmediate(() => child.emit("close", null)); return true; },
			});
			return child as unknown as ReturnType<typeof actual.spawn>;
		},
	};
});

import { listWorkspaceIndex } from "../src/lib/files-service";
import { recycleFixture } from "./lib/sandbox/fixtures";
let root: string;
beforeEach(async () => {
	gitScan.hang = false;
	root = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-index-bounds-"));
	execFileSync("git", ["init", "-q", root], { windowsHide: true });
	await Promise.all(Array.from({ length: 50 }, (_, index) => fs.writeFile(path.join(root, "file-" + String(index).padStart(3, "0") + ".txt"), "x")));
});
afterEach(async () => { gitScan.hang = false; await recycleFixture(root); });
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
	// A stalled Git process makes the 1ms timeout deterministic instead of racing a
	// real `git ls-files` that may complete before the timer callback.
	gitScan.hang = true;
	const result = await listWorkspaceIndex(root, { gitTimeoutMs: 1 });
	expect(result.source).toBe("disk"); expect(result.truncated).toBe(true); expect(result.warning).toContain(".gitignore");
	expect(result.files).toContain("file-000.txt");
});
