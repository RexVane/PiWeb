import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { gitDiff, gitInfo, gitShow, repoRoot } from "../src/lib/git-service";
import { recycleFixture } from "./fixtures/recycle";
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
	it("summarizes net tracked lines across the index and working tree, including the first commit", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-overview-git-"));
		const git = (...args: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.name=Test", "-c", "user.email=t@example.test", ...args], { windowsHide: true });
		const tracked = path.join(cwd, "notes.txt");
		try {
			git("init", "-q");
			await fs.writeFile(tracked, "old\n");
			git("add", "notes.txt");
			await fs.writeFile(tracked, "old\nsecond\n");
			await fs.writeFile(path.join(cwd, "untracked.txt"), "new file\n");
			expect(await gitInfo(cwd, "lines")).toMatchObject({ lineStats: { add: 2, del: 0 }, counts: { untracked: 1 }, files: [], commits: [] });

			git("commit", "-qm", "Initial");
			await fs.writeFile(tracked, "intermediate edit\n");
			git("add", "notes.txt");
			await fs.writeFile(tracked, "old\nfinal\n");
			expect(await gitInfo(cwd, "lines")).toMatchObject({ lineStats: { add: 1, del: 0 }, counts: { total: 2, untracked: 1 } });
			expect((await gitInfo(cwd, true)).lineStats).toBeUndefined();
		} finally {
			await recycleFixture(cwd);
		}
	});

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
	it("shows non-ASCII file names verbatim in patch headers", async () => {
		const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-git-names-"));
		try {
			const git = (...args: string[]) => execFileSync("git", ["-C", temporary, "-c", "core.autocrlf=false", "-c", "user.name=test", "-c", "user.email=t@example.test", ...args], { windowsHide: true });
			git("init", "-q");
			const name = "中文 文件.txt";
			await fs.writeFile(path.join(temporary, name), "base");
			git("add", ".");
			git("commit", "-q", "-m", "base");
			await fs.writeFile(path.join(temporary, name), "changed");
			expect((await gitInfo(temporary)).files.map((file) => file.path)).toEqual([name]);
			const worktree = await gitDiff(temporary, name, "worktree");
			expect(worktree.patch).toContain(`b/${name}`);
			expect(worktree.patch).not.toContain("\\344");
			git("commit", "-qam", "change");
			const shown = await gitShow(temporary, git("rev-parse", "HEAD").toString().trim());
			expect(shown.patch).toContain(`b/${name}`);
		} finally {
			await recycleFixture(temporary);
		}
	}, 30_000);

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

describe("Git audit regressions", () => {
	it("renders merge commits and unresolved conflicts as ordinary unified patches", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-git-merge-"));
		const git = (...args: string[]) => execFileSync("git", ["-C", root, "-c", "core.autocrlf=false", "-c", "user.name=test", "-c", "user.email=t@example.test", ...args], { windowsHide: true });
		try {
			git("init", "-q"); await fs.writeFile(path.join(root, "a.txt"), "base\n"); git("add", "."); git("commit", "-q", "-m", "base");
			const main = git("branch", "--show-current").toString().trim();
			git("checkout", "-q", "-b", "side"); await fs.writeFile(path.join(root, "a.txt"), "side\n"); git("commit", "-qam", "side");
			git("checkout", "-q", main); await fs.writeFile(path.join(root, "a.txt"), "main\n"); git("commit", "-qam", "main");
			try { git("merge", "side"); } catch { /* expected conflict */ }
			const conflict = await gitDiff(root, "a.txt", "worktree");
			expect(conflict.patch).toContain("@@ -"); expect(conflict.patch).not.toContain("@@@");
			expect(conflict.patch).toContain("<<<<<<<"); expect(conflict.stats.add).toBeGreaterThan(0);
			await fs.writeFile(path.join(root, "a.txt"), "merged\n"); git("add", "."); git("commit", "-q", "-m", "merge");
			const merge = await gitShow(root, git("rev-parse", "HEAD").toString().trim());
			expect(merge.patch).toContain("@@ -"); expect(merge.patch).not.toContain("@@@");
			expect(merge.patch).toContain("+merged");
		} finally { await recycleFixture(root); }
	});
	it("retains a bounded preview for a diff larger than execFile's former 8 MiB limit", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-git-stream-"));
		const git = (...args: string[]) => execFileSync("git", ["-C", root, "-c", "core.autocrlf=false", "-c", "user.name=test", "-c", "user.email=t@example.test", ...args], { windowsHide: true });
		try {
			git("init", "-q"); await fs.writeFile(path.join(root, "large.txt"), "before\n"); git("add", "."); git("commit", "-q", "-m", "base");
			await fs.writeFile(path.join(root, "large.txt"), "x".repeat(9 * 1024 * 1024) + "\n");
			const diff = await gitDiff(root, "large.txt", "worktree");
			expect(diff.truncated).toBe(true); expect(Buffer.byteLength(diff.patch)).toBeLessThanOrEqual(400 * 1024);
			expect(diff.stats).toEqual({ add: 1, del: 1 });
		} finally { await recycleFixture(root); }
	});
	it("lists untracked files individually and never discovers a parent repository", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-git-ceiling-"));
		try {
			execFileSync("git", ["init", "-q", root], { windowsHide: true });
			const child = path.join(root, "nested"); await fs.mkdir(child);
			await fs.writeFile(path.join(child, "new.txt"), "new");
			expect((await gitInfo(root)).files.map((file) => file.path)).toContain("nested/new.txt");
			expect(await repoRoot(child)).toEqual({ available: true, root: null });
			await expect(gitDiff(child, "../outside.txt", "worktree")).rejects.toThrow("not a git repository");
		} finally { await recycleFixture(root); }
	});
	it("does not execute a repository-provided fsmonitor command", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-git-fsmonitor-"));
		try {
			execFileSync("git", ["init", "-q", root], { windowsHide: true });
			const marker = path.join(root, "called.txt");
			const script = path.join(root, "monitor.cjs");
			await fs.writeFile(script, 'require("node:fs").writeFileSync(' + JSON.stringify(marker) + ',"called");');
			execFileSync("git", ["-C", root, "config", "core.fsmonitor", '"' + process.execPath.replaceAll("\\", "/") + '" "' + script.replaceAll("\\", "/") + '"'], { windowsHide: true });
			expect((await gitInfo(root)).isRepo).toBe(true);
			await expect(fs.access(marker)).rejects.toMatchObject({ code: "ENOENT" });
		} finally { await recycleFixture(root); }
	});
});
