import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	changesBetween,
	commitRound,
	fileContent,
	filePatch,
	isAvailable,
	listTree,
	parseLsTree,
	parseNameStatus,
	parseNumstat,
	parseRoundLog,
	parseRoundMessage,
	readRounds,
	recordWorkspaceChanges,
	workspaceKey,
} from "../src/lib/growth-service";

const git = (cwd: string, args: string[], input?: string) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true, input });

describe("growth-service parsers", () => {
	it("parses name-status with renames", () => {
		const raw = ["A", "src/new.ts", "M", "README.md", "D", "old.txt", "R087", "a.ts", "b.ts", "T", "link", ""].join("\0");
		expect(parseNameStatus(raw)).toEqual([
			{ status: "A", path: "src/new.ts" },
			{ status: "M", path: "README.md" },
			{ status: "D", path: "old.txt" },
			{ status: "R", path: "b.ts", from: "a.ts" },
			{ status: "M", path: "link" },
		]);
	});

	it("parses numstat including binary and renames", () => {
		const raw = ["3\t1\tsrc/new.ts", "-\t-\timg.png", "0\t0\t", "a.ts", "b.ts", ""].join("\0");
		const m = parseNumstat(raw);
		expect(m.get("src/new.ts")).toEqual({ add: 3, del: 1, binary: false });
		expect(m.get("img.png")).toEqual({ add: 0, del: 0, binary: true });
		expect(m.get("b.ts")).toEqual({ add: 0, del: 0, binary: false });
	});

	it("parses ls-tree blobs only", () => {
		const raw = ["100644 blob 0123456789abcdef0123456789abcdef01234567      12\tsrc/a b.ts", "160000 commit 0123456789abcdef0123456789abcdef01234567       -\tsub", ""].join("\0");
		expect(parseLsTree(raw)).toEqual([{ path: "src/a b.ts", size: 12 }]);
	});

	it("workspace keys are stable and case-insensitive on windows", () => {
		const a = workspaceKey("D:/AIApp/PiWeb");
		expect(a).toMatch(/^[a-z0-9-]+-[0-9a-f]{8}$/);
		if (process.platform === "win32") expect(workspaceKey("d:\\aiapp\\piweb")).toBe(a);
	});

	it("parses one git log stream of raw + numstat records, including empty commits, renames and binaries", () => {
		const h = (c: string) => c.repeat(40);
		const header = (commit: string, tree: string, parent: string, message: string) => `\x1e${[commit, tree, parent, "1791345318", message].join("\x1f")}\x1f\0`;
		const raw =
			header(h("a"), h("1"), "", "piweb: baseline\n\nPiweb-Kind: baseline\nPiweb-Session: s1.jsonl\n") +
			header(h("b"), h("2"), h("a"), "把按钮改红\n\nPiweb-Kind: round\nPiweb-Session: s1.jsonl\nPiweb-Prompts: e1,e2\nPiweb-Status: done\n") +
			`\n:100644 100644 ${h("3")} ${h("4")} M\0a.txt\0:000000 100644 ${h("0")} ${h("5")} A\0img.bin\0` +
			`:100644 100644 ${h("6")} ${h("6")} R100\0old.txt\0new.txt\0:000000 100644 ${h("0")} ${h("7")} A\0src/sp ace.ts\0` +
			"2\t1\ta.txt\0-\t-\timg.bin\0" + "0\t0\t\0old.txt\0new.txt\0" + "1\t0\tsrc/sp ace.ts\0" +
			header(h("c"), h("2"), h("b"), "piweb: round\n\nPiweb-Kind: round\nPiweb-Session: s1.jsonl\nPiweb-Status: aborted\n");
		const commits = parseRoundLog(raw);
		expect(commits.map((c) => [c.commit, c.parent, c.tree])).toEqual([[h("a"), null, h("1")], [h("b"), h("a"), h("2")], [h("c"), h("b"), h("2")]]);
		expect(commits[0].changes).toEqual([]);
		expect(commits[1].ts).toBe(1791345318000);
		expect(commits[1].changes).toEqual([
			{ status: "M", path: "a.txt", add: 2, del: 1 },
			{ status: "A", path: "img.bin", add: 0, del: 0, binary: true },
			{ status: "R", path: "new.txt", from: "old.txt", add: 0, del: 0 },
			{ status: "A", path: "src/sp ace.ts", add: 1, del: 0 },
		]);
		expect(commits[2].changes).toEqual([]);
		expect(parseRoundMessage(commits[1].message)).toEqual({ kind: "round", title: "把按钮改红", session: "s1.jsonl", promptIds: ["e1", "e2"], status: "done" });
		// 纯图片提问的默认标题还原成空，界面用自己的文案
		expect(parseRoundMessage(commits[2].message)).toMatchObject({ title: "", status: "aborted", promptIds: [] });
		expect(parseRoundMessage(commits[0].message)).toMatchObject({ kind: "baseline", title: "" });
	});
});

describe("growth-service rounds (real git)", () => {
	let tempDir = "";
	let work = "";
	let available = false;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-growth-"));
		work = path.join(tempDir, "work");
		await fs.mkdir(work, { recursive: true });
		available = await isAvailable();
	});

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
	});

	it("commits one round per call with trailers, records user edits separately and serves diffs", async () => {
		if (!available) return;
		const session = path.join(tempDir, "s1.jsonl");
		await fs.writeFile(path.join(work, "README.md"), "# hi\nline2\n");
		await fs.mkdir(path.join(work, "node_modules", "x"), { recursive: true });
		await fs.writeFile(path.join(work, "node_modules", "x", "index.js"), "ignored");

		const base = await recordWorkspaceChanges(work, session);
		expect(base).toMatchObject({ kind: "baseline", initial: true, changes: [], parent: null });
		expect((await listTree(work, base!.tree)).map((f) => f.path)).toEqual(["README.md"]);
		// 没改动：不记「你的修改」
		expect(await recordWorkspaceChanges(work, session)).toBeNull();

		await fs.mkdir(path.join(work, "src"), { recursive: true });
		await fs.writeFile(path.join(work, "src", "app.ts"), "export const a = 1;\n");
		await fs.writeFile(path.join(work, "README.md"), "# hi\nline2 changed\nline3\n");
		const r1 = await commitRound(work, { kind: "round", session, title: "把 README\t改一下", promptIds: ["e1", "bad id!"] });
		expect(r1).toMatchObject({ kind: "round", title: "把 README 改一下", promptIds: ["e1"], status: "done", parent: base!.commit, parentTree: base!.tree });
		expect(r1?.changes).toEqual([
			{ status: "M", path: "README.md", add: 2, del: 1 },
			{ status: "A", path: "src/app.ts", add: 1, del: 0 },
		]);
		expect(r1?.stats).toMatchObject({ added: 1, modified: 1, deleted: 0, add: 3, del: 1 });

		// 没有改动的一轮也提交（空 commit），轮号与对话一一对应
		const r2 = await commitRound(work, { kind: "round", session, title: "只是问个问题", status: "aborted" });
		expect(r2).toMatchObject({ kind: "round", status: "aborted", tree: r1!.tree, parent: r1!.commit, changes: [] });

		await fs.rm(path.join(work, "README.md"));
		await fs.rename(path.join(work, "src", "app.ts"), path.join(work, "src", "main.ts"));
		const user = await recordWorkspaceChanges(work, session);
		expect(user?.kind).toBe("user");
		expect(user?.changes).toEqual([
			{ status: "D", path: "README.md", add: 0, del: 3 },
			{ status: "R", path: "src/main.ts", from: "src/app.ts", add: 0, del: 0 },
		]);

		const rounds = await readRounds(work, session);
		expect(rounds.map((r) => r.kind)).toEqual(["baseline", "round", "round", "user"]);
		expect(rounds.map((r) => r.commit)).toEqual([base!.commit, r1!.commit, r2!.commit, user!.commit]);
		expect(await readRounds(work, path.join(tempDir, "other.jsonl"))).toEqual([]);

		// 元信息全在 git 里：终端 git log 就能看到同样的历史
		const ref = `refs/piweb/rounds/${workspaceKey(work)}`;
		expect(git(work, ["log", "--format=%s", ref]).trim().split("\n")).toEqual(["piweb: workspace changes", "只是问个问题", "把 README 改一下", "piweb: baseline"]);
		expect(git(work, ["log", "-1", "--format=%B", r1!.commit])).toContain("Piweb-Prompts: e1\n");
		expect(await fs.stat(path.join(work, ".git", "piweb", "ledger.jsonl")).catch(() => null)).toBeNull();

		expect(await changesBetween(work, base!.tree, user!.tree)).toEqual([
			{ status: "D", path: "README.md", add: 0, del: 2 },
			{ status: "A", path: "src/main.ts", add: 1, del: 0 },
		]);
		const patch = await filePatch(work, r1!.parentTree, r1!.tree, "README.md");
		expect(patch.patch).toContain("-line2");
		expect(patch.patch).toContain("+line2 changed");
		expect((await fileContent(work, r1!.tree, "README.md")).content).toBe("# hi\nline2 changed\nline3\n");
		await expect(fileContent(work, user!.tree, "README.md")).rejects.toThrow(/not found/);
	}, 30_000);

	it("reads the same timeline back from git log in a fresh process", async () => {
		if (!available) return;
		const session = path.join(tempDir, "fresh.jsonl");
		await fs.writeFile(path.join(work, "a.txt"), "a\nb\n");
		await fs.writeFile(path.join(work, "old.txt"), "keep me\n");
		await recordWorkspaceChanges(work, session);
		await fs.writeFile(path.join(work, "a.txt"), "a\nB\nc\n");
		await fs.rename(path.join(work, "old.txt"), path.join(work, "new.txt"));
		await fs.writeFile(path.join(work, "img.bin"), Buffer.from([0, 1, 2, 3]));
		await commitRound(work, { kind: "round", session, title: "第一轮", promptIds: ["p1", "p2"] });
		await commitRound(work, { kind: "round", session, title: "第二轮（空）" });
		const live = await readRounds(work, session);

		const globals = globalThis as { __piWebGrowthRounds?: unknown };
		const saved = globals.__piWebGrowthRounds;
		delete globals.__piWebGrowthRounds;
		vi.resetModules();
		try {
			const fresh = await import("../src/lib/growth-service");
			const reread = await fresh.readRounds(work, session);
			// 只有提交时间精度不同（commit 只存到秒）
			const strip = (rounds: typeof live) => rounds.map(({ ts, ...rest }) => rest);
			expect(strip(reread)).toEqual(strip(live));
			expect(reread[1].changes).toEqual([
				{ status: "M", path: "a.txt", add: 2, del: 1 },
				{ status: "A", path: "img.bin", add: 0, del: 0, binary: true },
				{ status: "R", path: "new.txt", from: "old.txt", add: 0, del: 0 },
			]);
			expect(reread[1].promptIds).toEqual(["p1", "p2"]);
			expect(reread[2]).toMatchObject({ title: "第二轮（空）", changes: [], parentTree: reread[1].tree });
		} finally {
			globals.__piWebGrowthRounds = saved;
			vi.resetModules();
		}
	}, 30_000);

	it("re-parents onto a head another process committed first", async () => {
		if (!available) return;
		const session = path.join(tempDir, "race.jsonl");
		await fs.writeFile(path.join(work, "a.txt"), "a\n");
		const base = await recordWorkspaceChanges(work, session);
		const ref = `refs/piweb/rounds/${workspaceKey(work)}`;
		// 模拟另一个 PiWeb 进程：直接在链头后面挂一个 commit
		const env = { ...process.env, GIT_AUTHOR_NAME: "x", GIT_AUTHOR_EMAIL: "x@x", GIT_COMMITTER_NAME: "x", GIT_COMMITTER_EMAIL: "x@x" };
		const other = execFileSync("git", ["-C", work, "commit-tree", base!.tree, "-p", base!.commit, "-m", "other process"], { encoding: "utf8", windowsHide: true, env }).trim();
		git(work, ["update-ref", ref, other, base!.commit]);

		await fs.writeFile(path.join(work, "a.txt"), "a\nb\n");
		const mine = await commitRound(work, { kind: "round", session, title: "mine" });
		expect(mine?.parent).toBe(other);
		expect(git(work, ["rev-parse", ref]).trim()).toBe(mine!.commit);
		expect((await readRounds(work)).map((r) => r.commit)).toEqual([base!.commit, other, mine!.commit]);
	}, 20_000);

	it("never creates a repository just to read", async () => {
		if (!available) return;
		await fs.writeFile(path.join(work, "a.txt"), "a\n");
		expect(await readRounds(work, path.join(tempDir, "s.jsonl"))).toEqual([]);
		expect(await fs.stat(path.join(work, ".git")).catch(() => null)).toBeNull();
		// 已有仓库但还没有专用引用：同样只读
		git(work, ["init", "-q"]);
		expect(await readRounds(work)).toEqual([]);
		expect(await fs.stat(path.join(work, ".git", "piweb")).catch(() => null)).toBeNull();
	}, 20_000);

	it("indexes a workspace across multiple bounded batches", async () => {
		if (!available) return;
		const session = path.join(tempDir, "large.jsonl");
		const files = Array.from({ length: 300 }, (_, index) => `file-${String(index).padStart(4, "0")}.txt`);
		for (let offset = 0; offset < files.length; offset += 100) {
			await Promise.all(files.slice(offset, offset + 100).map((name) => fs.writeFile(path.join(work, name), name)));
		}
		const base = await recordWorkspaceChanges(work, session);
		expect(base?.initial).toBe(true);
		expect(await listTree(work, base!.tree)).toHaveLength(files.length);
		await fs.writeFile(path.join(work, files[0]), "changed");
		const changed = await commitRound(work, { kind: "round", session, title: "edit" });
		expect(changed?.changes).toEqual([{ status: "M", path: files[0], add: 1, del: 1 }]);
	}, 20_000);

	it("auto-initializes a non-git workspace and keeps HEAD unborn", async () => {
		if (!available) return;
		const session = path.join(tempDir, "init.jsonl");
		await fs.writeFile(path.join(work, "a.txt"), "a\n");
		expect(await fs.stat(path.join(work, ".git")).catch(() => null)).toBeNull();

		const base = await recordWorkspaceChanges(work, session);
		expect(base?.initial).toBe(true);
		// 自动 init 的仓库：HEAD 指向未诞生分支，commit 链只挂在专用引用上
		const head = await fs.readFile(path.join(work, ".git", "HEAD"), "utf8");
		expect(head.trim()).toMatch(/^ref: refs\/heads\//);
		expect(git(work, ["for-each-ref", "--format=%(refname)", "refs/piweb/"]).trim()).toBe(`refs/piweb/rounds/${workspaceKey(work)}`);
		// 用户分支引用一个都不许有
		expect(git(work, ["for-each-ref", "refs/heads/"])).toBe("");
		expect((await listTree(work, base!.tree)).map((f) => f.path)).toEqual(["a.txt"]);
		expect((await readRounds(work, session)).map((r) => r.kind)).toEqual(["baseline"]);
	}, 20_000);

	it("nested-initializes a workspace that is a subdirectory of another repository", async () => {
		if (!available) return;
		const session = path.join(tempDir, "nested.jsonl");
		const parent = path.join(tempDir, "parent-repo");
		const sub = path.join(parent, "sub");
		await fs.mkdir(sub, { recursive: true });
		execFileSync("git", ["init", "-q", parent], { windowsHide: true });
		const parentRefsBefore = git(parent, ["for-each-ref"]);
		const parentIndexBefore = await fs.readFile(path.join(parent, ".git", "index")).catch(() => null);
		await fs.writeFile(path.join(sub, "inner.txt"), "inner\n");
		await fs.writeFile(path.join(parent, "outer.txt"), "outer\n");

		const base = await recordWorkspaceChanges(sub, session);
		expect(base?.initial).toBe(true);
		// 记录范围恰好是工作区：父仓库的 outer.txt 不出现
		expect((await listTree(sub, base!.tree)).map((f) => f.path)).toEqual(["inner.txt"]);
		// 父仓库零改动（无新引用、index 原样）
		expect(git(parent, ["for-each-ref"])).toBe(parentRefsBefore);
		const parentIndexAfter = await fs.readFile(path.join(parent, ".git", "index")).catch(() => null);
		expect(parentIndexAfter === null ? parentIndexBefore === null : parentIndexBefore !== null && parentIndexAfter.equals(parentIndexBefore)).toBe(true);
	}, 20_000);

	it("preserves the workspace Git index across non-empty file/directory replacements", async () => {
		if (!available) return;
		const session = path.join(tempDir, "type-replacements.jsonl");
		const target = path.join(work, "p");
		await fs.writeFile(target, "original file\n");
		execFileSync("git", ["init", "-q", work], { windowsHide: true });
		execFileSync("git", ["-C", work, "-c", "core.autocrlf=false", "add", "--", "p"], { windowsHide: true });
		const gitDir = path.join(work, ".git");
		const indexBefore = await fs.readFile(path.join(gitDir, "index"));
		const headBefore = await fs.readFile(path.join(gitDir, "HEAD"));
		const configBefore = await fs.readFile(path.join(gitDir, "config"));
		const entriesBefore = (await fs.readdir(gitDir, { recursive: true })).sort();

		const base = await recordWorkspaceChanges(work, session);
		await fs.rm(target);
		await fs.mkdir(target);
		await fs.writeFile(path.join(target, "child.txt"), "different child contents\n");
		const directory = await commitRound(work, { kind: "round", session, title: "file to directory" });
		expect(directory?.parentTree).toBe(base!.tree);
		expect(directory?.changes).toEqual([
			{ status: "D", path: "p", add: 0, del: 1 },
			{ status: "A", path: "p/child.txt", add: 1, del: 0 },
		]);
		expect((await listTree(work, directory!.tree)).map((file) => file.path)).toEqual(["p/child.txt"]);

		await fs.rm(target, { recursive: true });
		await fs.writeFile(target, "replacement file\n");
		const file = await commitRound(work, { kind: "round", session, title: "directory to file" });
		expect(file?.parentTree).toBe(directory!.tree);
		expect(file?.changes).toEqual([
			{ status: "A", path: "p", add: 1, del: 0 },
			{ status: "D", path: "p/child.txt", add: 0, del: 1 },
		]);
		expect((await listTree(work, file!.tree)).map((entry) => entry.path)).toEqual(["p"]);
		expect((await fileContent(work, base!.tree, "p")).content).toBe("original file\n");
		expect((await changesBetween(work, base!.tree, file!.tree))).toEqual([{ status: "M", path: "p", add: 1, del: 1 }]);
		expect(await recordWorkspaceChanges(work, session)).toBeNull();
		// 用户仓库自身的 index / HEAD / config 一个字节都不能动
		expect((await fs.readFile(path.join(gitDir, "index"))).equals(indexBefore)).toBe(true);
		expect((await fs.readFile(path.join(gitDir, "HEAD"))).equals(headBefore)).toBe(true);
		expect((await fs.readFile(path.join(gitDir, "config"))).equals(configBefore)).toBe(true);
		// 新增条目只允许是 commit 对象、专用引用和 piweb 私有目录
		const entriesAfter = (await fs.readdir(gitDir, { recursive: true })).sort();
		const fresh = entriesAfter.filter((entry) => !entriesBefore.includes(entry));
		expect(fresh.every((entry) => /^(objects([\\/]|$)|refs[\\/]piweb([\\/]|$)|piweb([\\/]|$))/.test(entry))).toBe(true);
		expect(fresh.some((entry) => entry.startsWith("piweb"))).toBe(true);
	}, 30_000);

	it("removes all type conflicts before adding paths across multiple batches", async () => {
		if (!available) return;
		const session = path.join(tempDir, "type-batches.jsonl");
		const names = Array.from({ length: 300 }, (_, index) => `p-${String(index).padStart(4, "0")}`);
		for (const name of names) await fs.writeFile(path.join(work, name), `original ${name}\n`);
		const base = await recordWorkspaceChanges(work, session);
		for (const name of names) {
			await fs.rm(path.join(work, name));
			await fs.mkdir(path.join(work, name));
			await fs.writeFile(path.join(work, name, "child.txt"), `child ${name}\n`);
		}
		const directories = await commitRound(work, { kind: "round", session, title: "replace with directories" });
		expect((await listTree(work, directories!.tree)).map((file) => file.path)).toEqual(names.map((name) => `${name}/child.txt`));
		for (const name of names) {
			await fs.rm(path.join(work, name), { recursive: true });
			await fs.writeFile(path.join(work, name), `replacement ${name}\n`);
		}
		const files = await commitRound(work, { kind: "round", session, title: "replace with files" });
		expect((await listTree(work, files!.tree)).map((file) => file.path)).toEqual(names);
		expect((await listTree(work, base!.tree)).map((file) => file.path)).toEqual(names);
		expect((await fileContent(work, base!.tree, names[0])).content).toBe(`original ${names[0]}\n`);
	}, 90_000);

	it("force-removes tracked paths replaced by symbolic links", async (context) => {
		if (!available) return;
		const session = path.join(tempDir, "symlink-replacement.jsonl");
		const outside = path.join(tempDir, "outside.txt");
		const target = path.join(work, "p.txt");
		await fs.writeFile(outside, "must not snapshot linked contents\n");
		await fs.writeFile(target, "original\n");
		const base = await recordWorkspaceChanges(work, session);
		await fs.rm(target);
		try {
			await fs.symlink(outside, target, "file");
		} catch (error) {
			if (process.platform === "win32" && ["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) {
				context.skip("Windows file symlinks require Developer Mode or symlink privileges");
				return;
			}
			throw error;
		}
		const changed = await commitRound(work, { kind: "round", session, title: "file to symlink" });
		expect(changed?.changes).toEqual([{ status: "D", path: "p.txt", add: 0, del: 1 }]);
		expect(await listTree(work, changed!.tree)).toEqual([]);
		expect((await fileContent(work, base!.tree, "p.txt")).content).toBe("original\n");
		expect(await recordWorkspaceChanges(work, session)).toBeNull();
	}, 20_000);

	it("removes a file replaced by a linked directory without snapshotting its target", async () => {
		if (!available) return;
		const session = path.join(tempDir, "junction-replacement.jsonl");
		const outside = path.join(tempDir, "outside");
		const target = path.join(work, "p");
		await fs.mkdir(outside);
		await fs.writeFile(path.join(outside, "secret.txt"), "outside workspace\n");
		await fs.writeFile(target, "original\n");
		const base = await recordWorkspaceChanges(work, session);
		await fs.rm(target);
		await fs.symlink(outside, target, process.platform === "win32" ? "junction" : "dir");
		const changed = await commitRound(work, { kind: "round", session, title: "file to linked directory" });
		expect(changed?.changes).toEqual([{ status: "D", path: "p", add: 0, del: 1 }]);
		expect(await listTree(work, changed!.tree)).toEqual([]);
		expect((await fileContent(work, base!.tree, "p")).content).toBe("original\n");
	}, 20_000);

	it("removes tracked content when a file becomes a directory", async () => {
		if (!available) return;
		const session = path.join(tempDir, "type-change.jsonl");
		const target = path.join(work, "tracked.txt");
		await fs.writeFile(target, "original\n");
		const base = await recordWorkspaceChanges(work, session);
		expect((await listTree(work, base!.tree)).map((file) => file.path)).toEqual(["tracked.txt"]);
		await fs.rm(target);
		await fs.mkdir(target);
		const changed = await commitRound(work, { kind: "round", session, title: "replace file" });
		expect(changed?.changes).toEqual([{ status: "D", path: "tracked.txt", add: 0, del: 1 }]);
		expect(await listTree(work, changed!.tree)).toEqual([]);
	}, 20_000);
});
