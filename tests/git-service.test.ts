import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { gitDiff, gitInfo } from "../src/lib/git-service";
import { BoundaryError } from "../src/lib/path-security";

describe("Git status failures", () => {
	it("reports unknown instead of clean for a corrupt index and leaves Git files unchanged", async () => {
		const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-git-status-"));
		try {
			execFileSync("git", ["init", "-q", temporary], { windowsHide: true });
			const clean = await gitInfo(temporary);
			expect(clean).toMatchObject({ available: true, isRepo: true, files: [] });
			expect(clean.statusError).toBeUndefined();
			const index = path.join(temporary, ".git", "index");
			const corrupted = Buffer.from("broken index fixture\n");
			await fs.writeFile(index, corrupted);
			const head = await fs.readFile(path.join(temporary, ".git", "HEAD"));
			const info = await gitInfo(temporary);
			expect(info).toMatchObject({ available: true, isRepo: true, files: [] });
			expect(info.statusError).toMatch(/index|signature/i);
			expect((await fs.readFile(index)).equals(corrupted)).toBe(true);
			expect((await fs.readFile(path.join(temporary, ".git", "HEAD"))).equals(head)).toBe(true);
			await fs.rm(index);
			expect((await gitInfo(temporary)).statusError).toBeUndefined();
		} finally {
			await fs.rm(temporary, { recursive: true, force: true });
		}
	}, 15_000);
});

describe("untracked Git diffs", () => {
	it("bounds large reads and rejects directory links outside the repository", async () => {
		const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-git-diff-"));
		try {
			const repo = path.join(temporary, "repo");
			const outside = path.join(temporary, "outside");
			await fs.mkdir(repo);
			await fs.mkdir(outside);
			execFileSync("git", ["init", "-q", repo], { windowsHide: true });
			await fs.writeFile(path.join(repo, "large.txt"), Buffer.alloc(500 * 1024, 0x61));
			const diff = await gitDiff(repo, "large.txt", "untracked");
			expect(diff.truncated).toBe(true);
			expect(diff.patch.length).toBeLessThan(450 * 1024);

			await fs.writeFile(path.join(outside, "secret.txt"), "outside");
			await fs.symlink(outside, path.join(repo, "linked"), process.platform === "win32" ? "junction" : "dir");
			await expect(gitDiff(repo, "linked/secret.txt", "untracked")).rejects.toBeInstanceOf(BoundaryError);
		} finally {
			await fs.rm(temporary, { recursive: true, force: true });
		}
	});
});
