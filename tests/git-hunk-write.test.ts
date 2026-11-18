import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	gitCommit,
	gitCommitFiles,
	gitDiff,
	gitFileContent,
	gitHunkAction,
	gitInfo,
	gitPush,
	gitPull,
	gitStage,
	gitUnstage,
	GitActionError,
} from "../src/lib/git-service";
import { parseRawPatchBlocks } from "../src/lib/git-hunk";
import { POST } from "../src/app/api/git/route";

const cleanupDirs: string[] = [];
afterEach(async () => {
	for (const dir of cleanupDirs.splice(0)) {
		await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
	}
});

async function makeTempRepo(prefix: string): Promise<{ dir: string; git: (...args: string[]) => string }> {
	const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
	cleanupDirs.push(dir);
	const git = (...args: string[]) =>
		execFileSync(
			"git",
			["-C", dir, "-c", "core.autocrlf=false", "-c", "user.name=Test User", "-c", "user.email=test@example.com", ...args],
			{ windowsHide: true, encoding: "utf8" },
		).trim();
	git("init", "-q");
	return { dir, git };
}

describe("Git workbench backend write & full-context diff operations", () => {
	it("stages and unstages individual hunks accurately while guarding stale anchors", async () => {
		const { dir, git } = await makeTempRepo("piweb-git-hunk-");
		const original = Array.from({ length: 24 }, (_, i) => `line_${i + 1}`).join("\n") + "\n";
		await fs.writeFile(path.join(dir, "app.ts"), original, "utf8");
		git("add", "app.ts");
		git("commit", "-q", "-m", "initial");

		const modified = original
			.replace("line_2\n", "line_2_changed\n")
			.replace("line_20\n", "line_20_changed\nline_20_extra\n");
		await fs.writeFile(path.join(dir, "app.ts"), modified, "utf8");

		// fullContext returns the complete file lines for FileViewer
		const fullWorktree = await gitDiff(dir, "app.ts", "worktree", { fullContext: true });
		expect(fullWorktree.patch).toContain(" line_1\n");
		expect(fullWorktree.patch).toContain(" line_12\n");
		const workBlocks = parseRawPatchBlocks(fullWorktree.patch).blocks;
		expect(workBlocks).toHaveLength(2);

		// Stage ONLY the second hunk (#1)
		await gitHunkAction(dir, "app.ts", "stageHunk", "worktree", 1, workBlocks[1].anchor);
		const stagedDiff1 = await gitDiff(dir, "app.ts", "staged");
		expect(stagedDiff1.patch).toContain("line_20_changed");
		expect(stagedDiff1.patch).toContain("line_20_extra");
		expect(stagedDiff1.patch).not.toContain("line_2_changed");

		const remainingWorkDiff = await gitDiff(dir, "app.ts", "worktree");
		expect(remainingWorkDiff.patch).toContain("line_2_changed");
		expect(remainingWorkDiff.patch).not.toContain("line_20_changed");

		// Stale anchor mismatch must fail safely instead of staging the wrong block
		await expect(
			gitHunkAction(dir, "app.ts", "stageHunk", "worktree", 0, { ...workBlocks[0].anchor, delCount: 99 }),
		).rejects.toBeInstanceOf(GitActionError);

		// Stage the remaining first hunk too
		await gitHunkAction(dir, "app.ts", "stageHunk", "worktree", 0, workBlocks[0].anchor);
		expect((await gitDiff(dir, "app.ts", "worktree")).patch).toBe("");

		// Unstage only hunk #1 from staged area
		const fullStaged = await gitDiff(dir, "app.ts", "staged", { fullContext: true });
		const stagedBlocks = parseRawPatchBlocks(fullStaged.patch).blocks;
		expect(stagedBlocks).toHaveLength(2);
		await gitHunkAction(dir, "app.ts", "unstageHunk", "staged", 1, stagedBlocks[1].anchor);

		const afterUnstageStaged = await gitDiff(dir, "app.ts", "staged");
		expect(afterUnstageStaged.patch).toContain("line_2_changed");
		expect(afterUnstageStaged.patch).not.toContain("line_20_changed");
	}, 20_000);

	it("handles unborn HEAD staging/unstaging, missing EOF newline, UTF-8 names, and repo serialization locks", async () => {
		const { dir } = await makeTempRepo("piweb-git-unborn-");
		const utfFile = "中文 说明.txt";
		await fs.writeFile(path.join(dir, utfFile), "hello", "utf8");
		await fs.writeFile(path.join(dir, "second.txt"), "two\n", "utf8");

		// Parallel stage operations must serialize without index.lock conflict
		await Promise.all([gitStage(dir, [utfFile]), gitStage(dir, ["second.txt"])]);
		let info = await gitInfo(dir);
		expect(info.files.every((f) => f.indexStatus === "A")).toBe(true);

		// Unstaging on unborn HEAD removes from index cleanly back to untracked
		await gitHunkAction(dir, utfFile, "unstageHunk", "staged", 0);
		info = await gitInfo(dir);
		expect(info.files.find((f) => f.path === utfFile)?.kind).toBe("untracked");

		await gitStage(dir, [utfFile]);
		await gitUnstage(dir, "all");
		info = await gitInfo(dir);
		expect(info.files.every((f) => f.kind === "untracked")).toBe(true);

		// Missing EOF newline hunk test
		await fs.writeFile(path.join(dir, "nonewline.txt"), "first", "utf8");
		await gitStage(dir, ["nonewline.txt"]);
		const c1 = await gitCommit(dir, "feat: initial commit\n\nWith second paragraph body");
		expect(c1.hash).toMatch(/^[0-9a-f]{7,}$/);

		await fs.writeFile(path.join(dir, "nonewline.txt"), "changed", "utf8");
		await gitHunkAction(dir, "nonewline.txt", "stageHunk", "worktree", 0);
		const stagedNoNl = await gitDiff(dir, "nonewline.txt", "staged");
		expect(stagedNoNl.patch).toContain("+changed");
	}, 20_000);

	it("inspects commit files, full commit file diffs, object contents, and pushes/pulls against a bare remote", async () => {
		const bareDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "piweb-git-bare-")));
		cleanupDirs.push(bareDir);
		execFileSync("git", ["init", "--bare", "-q", bareDir], { windowsHide: true });

		const { dir, git } = await makeTempRepo("piweb-git-remote-");
		git("remote", "add", "origin", bareDir);
		await fs.writeFile(path.join(dir, "hello.ts"), "export const v = 1;\n", "utf8");
		await gitStage(dir, ["hello.ts"]);
		const c1 = await gitCommit(dir, "chore: add hello");
		await fs.writeFile(path.join(dir, "hello.ts"), "export const v = 2;\n", "utf8");
		await gitStage(dir, ["hello.ts"]);
		const c2 = await gitCommit(dir, "feat: bump hello to v2", { push: true });
		expect(c2.pushed).toBe(true);

		const commitDetails = await gitCommitFiles(dir, c2.hash);
		expect(commitDetails.files).toEqual([
			{ path: "hello.ts", status: "M", add: 1, del: 1, binary: false },
		]);

		const fullCommitDiff = await gitDiff(dir, "hello.ts", "commit", { fullContext: true, hash: c2.hash });
		expect(fullCommitDiff.patch).toContain("-export const v = 1;");
		expect(fullCommitDiff.patch).toContain("+export const v = 2;");

		const oldContent = await gitFileContent(dir, "hello.ts", c1.hash);
		expect(oldContent.content).toBe("export const v = 1;\n");

		// Pull cleanly succeeds when up-to-date
		await expect(gitPush(dir)).resolves.toBeDefined();
		await expect(gitPull(dir)).resolves.toBeDefined();
	}, 20_000);

	it("enforces same-origin protection on POST /api/git and dispatches valid mutations", async () => {
		const { dir } = await makeTempRepo("piweb-git-api-");
		await fs.writeFile(path.join(dir, "a.txt"), "hello\n", "utf8");

		const evil = new Request("http://127.0.0.1:30141/api/git", {
			method: "POST",
			headers: { origin: "https://evil.test", "content-type": "application/json" },
			body: JSON.stringify({ action: "stage", cwd: dir, all: true }),
		});
		expect((await POST(evil)).status).toBe(403);

		const okStage = new Request("http://127.0.0.1:30141/api/git", {
			method: "POST",
			headers: { origin: "http://127.0.0.1:30141", "sec-fetch-site": "same-origin", "content-type": "application/json" },
			body: JSON.stringify({ action: "stage", cwd: dir, path: "a.txt" }),
		});
		const stageRes = await POST(okStage);
		expect(stageRes.status).toBe(200);
		const stageJson = await stageRes.json();
		expect(stageJson.success).toBe(true);
		expect(stageJson.data.info.files[0].indexStatus).toBe("A");
	}, 20_000);

	it("blocks dash-prefixed remote/branch option injection in gitPush", async () => {
		const { dir, git } = await makeTempRepo("piweb-git-push-inj-");
		await fs.writeFile(path.join(dir, "seed.txt"), "ok\n", "utf8");
		await gitStage(dir, ["seed.txt"]);
		await gitCommit(dir, "initial");
		const branch = git("rev-parse", "--abbrev-ref", "HEAD");
		execFileSync("git", ["init", "--bare", "-q", path.join(dir, branch)], { windowsHide: true });
		const marker = path.join(dir, "pwned-marker");
		git("config", `remote.--receive-pack=touch ${marker}.url`, ".");

		await expect(gitPush(dir)).rejects.toMatchObject({ status: 400 });
		await expect(fs.stat(marker)).rejects.toThrow();
	}, 20_000);

	it("preserves exact non-UTF-8 (GBK) bytes during hunk staging and unstaging, handles renamed unstage, and caps large gitFileContent", async () => {
		const { dir, git } = await makeTempRepo("piweb-git-bytes-");
		const header = Buffer.from("header\n", "ascii");
		await fs.writeFile(path.join(dir, "gbk.txt"), header);
		await fs.writeFile(path.join(dir, "old.ts"), "export const a = 1;\nexport const b = 2;\nexport const c = 3;\nexport const d = 4;\n", "utf8");
		// 1 MB blob to verify bounded streaming in gitFileContent
		const bigSize = 1024 * 1024;
		await fs.writeFile(path.join(dir, "big.txt"), Buffer.alloc(bigSize, 0x41));
		git("add", "gbk.txt", "old.ts", "big.txt");
		git("commit", "-q", "-m", "initial");

		// Append GBK bytes ("中文\n": 0xd6 0xd0 0xce 0xc4 0x0a)
		const gbkTail = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x0a]);
		await fs.writeFile(path.join(dir, "gbk.txt"), Buffer.concat([header, gbkTail]));
		await gitHunkAction(dir, "gbk.txt", "stageHunk", "worktree", 0);
		const stagedBytes = execFileSync("git", ["-C", dir, "cat-file", "-p", ":0:gbk.txt"], { windowsHide: true });
		expect(stagedBytes.equals(Buffer.concat([header, gbkTail]))).toBe(true);

		await gitHunkAction(dir, "gbk.txt", "unstageHunk", "staged", 0);
		const restoredBytes = execFileSync("git", ["-C", dir, "cat-file", "-p", ":0:gbk.txt"], { windowsHide: true });
		expect(restoredBytes.equals(header)).toBe(true);

		// Renamed file unstage with [from, path] leaves no staged deletion of old.ts
		git("mv", "old.ts", "new.ts");
		await fs.writeFile(path.join(dir, "new.ts"), "export const a = 1;\nexport const b = 2;\nexport const c = 3;\nexport const d = 5;\n", "utf8");
		git("add", "new.ts");
		let info = await gitInfo(dir);
		expect(info.files.find((f) => f.path === "new.ts")).toMatchObject({ from: "old.ts", indexStatus: "R" });
		await gitUnstage(dir, ["old.ts", "new.ts"]);
		info = await gitInfo(dir);
		expect(info.files.find((f) => f.path === "old.ts" && f.indexStatus === "D")).toBeUndefined();

		// Large blob preview is truncated without loading full blob or returning 404
		const preview = await gitFileContent(dir, "big.txt", "HEAD");
		expect(preview.truncated).toBe(true);
		expect(preview.size).toBe(bigSize);
		expect(preview.content.length).toBeLessThanOrEqual(256 * 1024);
	}, 20_000);
});
