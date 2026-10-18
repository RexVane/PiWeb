import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { gitDiff, gitInfo, gitShow } from "../src/lib/git-service";
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

describe("recent commits", () => {
	it("splits hash, subject, author and relative time on the unit separator", async () => {
		const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-git-log-"));
		try {
			execFileSync("git", ["init", "-q", temporary], { windowsHide: true });
			await fs.writeFile(path.join(temporary, "a.txt"), "a\n");
			const git = (...args: string[]) => execFileSync("git", ["-C", temporary, "-c", "user.name=测试 作者", "-c", "user.email=t@example.test", ...args], { windowsHide: true });
			git("add", "a.txt");
			git("commit", "-q", "-m", "改一下 | 带空格的标题");
			const [commit] = (await gitInfo(temporary)).commits;
			expect(commit.hash).toMatch(/^[0-9a-f]{7,}$/);
			expect(commit.subject).toBe("改一下 | 带空格的标题");
			expect(commit.author).toBe("测试 作者");
			expect(commit.relative).not.toBe("");
		} finally {
			await fs.rm(temporary, { recursive: true, force: true });
		}
	}, 15_000);
});

describe("complete Git line counts", () => {
	it("keeps full numstat for truncated worktree/staged/commit/untracked patches and binary files", async () => {
		const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-git-numstat-"));
		try {
			const git = (...args: string[]) => execFileSync("git", ["-C", temporary, "-c", "core.autocrlf=false", "-c", "user.name=test", "-c", "user.email=t@example.test", ...args], { windowsHide: true });
			git("init", "-q");
			await fs.writeFile(path.join(temporary, "large.txt"), "original\n");
			git("add", ".");
			git("commit", "-q", "-m", "base");
			const lines = 7000;
			const content = Array.from({ length: lines }, (_, i) => `${i} ${"x".repeat(90)}\n`).join("");
			await fs.writeFile(path.join(temporary, "large.txt"), content);
			const worktree = await gitDiff(temporary, "large.txt", "worktree");
			expect(worktree).toMatchObject({ truncated: true, stats: { add: lines, del: 1 } });
			expect(worktree.patch.split("\n").filter((line) => line.startsWith("+")).length).toBeLessThan(lines);
			git("add", "large.txt");
			expect(await gitDiff(temporary, "large.txt", "staged")).toMatchObject({ truncated: true, stats: { add: lines, del: 1 } });
			git("commit", "-q", "-m", "large change");
			const hash = git("rev-parse", "HEAD").toString().trim();
			expect(await gitShow(temporary, hash)).toMatchObject({ truncated: true, stats: { add: lines, del: 1 } });
			await fs.writeFile(path.join(temporary, "untracked.txt"), content);
			expect(await gitDiff(temporary, "untracked.txt", "untracked")).toMatchObject({ truncated: true, stats: { add: lines, del: 0 } });
			await fs.writeFile(path.join(temporary, "binary.dat"), Buffer.from([0, 1, 2]));
			expect(await gitDiff(temporary, "binary.dat", "untracked")).toMatchObject({ binary: true, stats: { add: 0, del: 0 } });
		} finally {
			await fs.rm(temporary, { recursive: true, force: true });
		}
	}, 30_000);
});

describe("truncated patches with multi-byte text", () => {
	it("cuts on a character boundary instead of leaving a U+FFFD at the end", async () => {
		// 回归：按 400KB 直接 subarray，边界落在汉字中间时末尾多出一个替换字符（预览里的乱码方块）
		const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-git-utf8-"));
		try {
			const git = (...args: string[]) => execFileSync("git", ["-C", temporary, "-c", "core.autocrlf=false", "-c", "user.name=test", "-c", "user.email=t@example.test", ...args], { windowsHide: true });
			git("init", "-q");
			// 400 * 1024 不是 3 的倍数：整文件都是 3 字节汉字时，未跟踪文件的截断点必然落在字符中间
			await fs.writeFile(path.join(temporary, "untracked.txt"), "汉".repeat(140_000));
			const untracked = await gitDiff(temporary, "untracked.txt", "untracked");
			expect(untracked.truncated).toBe(true);
			expect(untracked.patch).not.toContain("�");
			// 工作区 diff 前面有 diff 头，对齐位置不定：错开 0/1/2 字节各试一次，至少两次会切在字符中间
			for (const pad of ["", "a", "ab"]) {
				const name = `tracked${pad.length}.txt`;
				await fs.writeFile(path.join(temporary, name), "base\n");
				git("add", name);
				git("commit", "-q", "-m", `base ${name}`);
				await fs.writeFile(path.join(temporary, name), `${pad}${"汉".repeat(140_000)}\n`);
				const worktree = await gitDiff(temporary, name, "worktree");
				expect(worktree.truncated).toBe(true);
				expect(worktree.patch).not.toContain("�");
			}
		} finally {
			await fs.rm(temporary, { recursive: true, force: true });
		}
	}, 30_000);
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
