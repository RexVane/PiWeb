import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { changesBetween, fileContent, filePatch, isAvailable, listTree, parseLsTree, parseNameStatus, parseNumstat, readSteps, snapshot, workspaceKey } from "../src/lib/growth-service";

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
});

describe("growth-service snapshots (real git)", () => {
	let tempDir = "";
	let previousAgentDir: string | undefined;
	let work = "";
	let available = false;

	beforeEach(async () => {
		previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-growth-"));
		process.env.PI_CODING_AGENT_DIR = path.join(tempDir, "agent");
		work = path.join(tempDir, "work");
		await fs.mkdir(work, { recursive: true });
		available = await isAvailable();
	});

	afterEach(async () => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
	});

	it("records baseline, additions, modifications, deletions and serves patches", async () => {
		if (!available) return;
		const session = path.join(tempDir, "s1.jsonl");
		await fs.writeFile(path.join(work, "README.md"), "# hi\nline2\n");
		await fs.mkdir(path.join(work, "node_modules", "x"), { recursive: true });
		await fs.writeFile(path.join(work, "node_modules", "x", "index.js"), "ignored");

		const base = await snapshot(work, { kind: "baseline", label: "", session, force: true });
		expect(base?.initial).toBe(true);
		expect(base?.changes).toEqual([]);
		expect((await listTree(work, base!.tree)).map((f) => f.path)).toEqual(["README.md"]);

		// tree 没变：不记步
		expect(await snapshot(work, { kind: "turn", label: "", session })).toBeNull();

		await fs.mkdir(path.join(work, "src"), { recursive: true });
		await fs.writeFile(path.join(work, "src", "app.ts"), "export const a = 1;\n");
		await fs.writeFile(path.join(work, "README.md"), "# hi\nline2 changed\nline3\n");
		const step2 = await snapshot(work, { kind: "tool", label: "bash · mkdir src", session, toolCallId: "t1", toolName: "bash" });
		expect(step2?.changes).toEqual([
			{ status: "M", path: "README.md", add: 2, del: 1 },
			{ status: "A", path: "src/app.ts", add: 1, del: 0 },
		]);
		expect(step2?.stats).toMatchObject({ added: 1, modified: 1, deleted: 0 });

		await fs.rm(path.join(work, "README.md"));
		const step3 = await snapshot(work, { kind: "tool", label: "bash · rm README.md", session, toolCallId: "t2", toolName: "bash" });
		expect(step3?.changes).toEqual([{ status: "D", path: "README.md", add: 0, del: 3 }]);

		const steps = await readSteps(work, session);
		expect(steps.map((s) => s.seq)).toEqual([1, 2, 3]);
		expect(await readSteps(work, path.join(tempDir, "other.jsonl"))).toEqual([]);

		const sessionChanges = await changesBetween(work, base!.tree, step3!.tree);
		expect(sessionChanges).toEqual([
			{ status: "D", path: "README.md", add: 0, del: 2 },
			{ status: "A", path: "src/app.ts", add: 1, del: 0 },
		]);

		const patch = await filePatch(work, base!.tree, step2!.tree, "README.md");
		expect(patch.binary).toBe(false);
		expect(patch.patch).toContain("-line2");
		expect(patch.patch).toContain("+line2 changed");
		expect(patch.patch).toContain(" # hi");

		const content = await fileContent(work, step2!.tree, "README.md");
		expect(content.content).toBe("# hi\nline2 changed\nline3\n");
		await expect(fileContent(work, step3!.tree, "README.md")).rejects.toThrow(/not found/);

		// 账本可以从磁盘重新读回（新进程）
		const ledger = await fs.readFile(path.join(tempDir, "agent", "web-growth", workspaceKey(work), "ledger.jsonl"), "utf8");
		expect(ledger.trim().split("\n")).toHaveLength(3);
	}, 20_000);

	it("indexes a workspace across multiple bounded batches", async () => {
		if (!available) return;
		const session = path.join(tempDir, "large.jsonl");
		const files = Array.from({ length: 300 }, (_, index) => `file-${String(index).padStart(4, "0")}.txt`);
		for (let offset = 0; offset < files.length; offset += 100) {
			await Promise.all(files.slice(offset, offset + 100).map((name) => fs.writeFile(path.join(work, name), name)));
		}
		const base = await snapshot(work, { kind: "baseline", label: "", session, force: true });
		expect(base?.initial).toBe(true);
		expect(await listTree(work, base!.tree)).toHaveLength(files.length);
		await fs.writeFile(path.join(work, files[0]), "changed");
		const changed = await snapshot(work, { kind: "tool", label: "edit", session });
		expect(changed?.changes).toEqual([{ status: "M", path: files[0], add: 1, del: 1 }]);
	}, 20_000);

	it("preserves baseline and the workspace Git index across non-empty file/directory replacements", async () => {
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

		const base = await snapshot(work, { kind: "baseline", label: "", session, force: true });
		await fs.rm(target);
		await fs.mkdir(target);
		await fs.writeFile(path.join(target, "child.txt"), "different child contents\n");
		const directory = await snapshot(work, { kind: "tool", label: "file to directory", session });
		expect(directory?.parent).toBe(base!.tree);
		expect(directory?.changes).toEqual([
			{ status: "D", path: "p", add: 0, del: 1 },
			{ status: "A", path: "p/child.txt", add: 1, del: 0 },
		]);
		expect((await listTree(work, directory!.tree)).map((file) => file.path)).toEqual(["p/child.txt"]);

		await fs.rm(target, { recursive: true });
		await fs.writeFile(target, "replacement file\n");
		const file = await snapshot(work, { kind: "tool", label: "directory to file", session });
		expect(file?.parent).toBe(directory!.tree);
		expect(file?.changes).toEqual([
			{ status: "A", path: "p", add: 1, del: 0 },
			{ status: "D", path: "p/child.txt", add: 0, del: 1 },
		]);
		expect((await listTree(work, file!.tree)).map((entry) => entry.path)).toEqual(["p"]);
		expect((await fileContent(work, base!.tree, "p")).content).toBe("original file\n");
		expect((await changesBetween(work, base!.tree, file!.tree))).toEqual([{ status: "M", path: "p", add: 1, del: 1 }]);
		expect(await snapshot(work, { kind: "turn", label: "", session })).toBeNull();
		expect((await fs.readFile(path.join(gitDir, "index"))).equals(indexBefore)).toBe(true);
		expect((await fs.readFile(path.join(gitDir, "HEAD"))).equals(headBefore)).toBe(true);
		expect((await fs.readFile(path.join(gitDir, "config"))).equals(configBefore)).toBe(true);
		expect((await fs.readdir(gitDir, { recursive: true })).sort()).toEqual(entriesBefore);
	}, 30_000);

	it("removes all type conflicts before adding paths across multiple batches", async () => {
		if (!available) return;
		const session = path.join(tempDir, "type-batches.jsonl");
		const names = Array.from({ length: 300 }, (_, index) => `p-${String(index).padStart(4, "0")}`);
		for (const name of names) await fs.writeFile(path.join(work, name), `original ${name}\n`);
		const base = await snapshot(work, { kind: "baseline", label: "", session, force: true });
		for (const name of names) {
			await fs.rm(path.join(work, name));
			await fs.mkdir(path.join(work, name));
			await fs.writeFile(path.join(work, name, "child.txt"), `child ${name}\n`);
		}
		const directories = await snapshot(work, { kind: "tool", label: "replace with directories", session });
		expect((await listTree(work, directories!.tree)).map((file) => file.path)).toEqual(names.map((name) => `${name}/child.txt`));
		for (const name of names) {
			await fs.rm(path.join(work, name), { recursive: true });
			await fs.writeFile(path.join(work, name), `replacement ${name}\n`);
		}
		const files = await snapshot(work, { kind: "tool", label: "replace with files", session });
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
		const base = await snapshot(work, { kind: "baseline", label: "", session, force: true });
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
		const changed = await snapshot(work, { kind: "tool", label: "file to symlink", session });
		expect(changed?.changes).toEqual([{ status: "D", path: "p.txt", add: 0, del: 1 }]);
		expect(await listTree(work, changed!.tree)).toEqual([]);
		expect((await fileContent(work, base!.tree, "p.txt")).content).toBe("original\n");
		expect(await snapshot(work, { kind: "turn", label: "", session })).toBeNull();
	}, 20_000);

	it("removes a file replaced by a linked directory without snapshotting its target", async () => {
		if (!available) return;
		const session = path.join(tempDir, "junction-replacement.jsonl");
		const outside = path.join(tempDir, "outside");
		const target = path.join(work, "p");
		await fs.mkdir(outside);
		await fs.writeFile(path.join(outside, "secret.txt"), "outside workspace\n");
		await fs.writeFile(target, "original\n");
		const base = await snapshot(work, { kind: "baseline", label: "", session, force: true });
		await fs.rm(target);
		await fs.symlink(outside, target, process.platform === "win32" ? "junction" : "dir");
		const changed = await snapshot(work, { kind: "tool", label: "file to linked directory", session });
		expect(changed?.changes).toEqual([{ status: "D", path: "p", add: 0, del: 1 }]);
		expect(await listTree(work, changed!.tree)).toEqual([]);
		expect((await fileContent(work, base!.tree, "p")).content).toBe("original\n");
	}, 20_000);

	it("removes tracked content when a file becomes a directory", async () => {
		if (!available) return;
		const session = path.join(tempDir, "type-change.jsonl");
		const target = path.join(work, "tracked.txt");
		await fs.writeFile(target, "original\n");
		const base = await snapshot(work, { kind: "baseline", label: "", session, force: true });
		expect((await listTree(work, base!.tree)).map((file) => file.path)).toEqual(["tracked.txt"]);
		await fs.rm(target);
		await fs.mkdir(target);
		const changed = await snapshot(work, { kind: "tool", label: "replace file", session });
		expect(changed?.changes).toEqual([{ status: "D", path: "tracked.txt", add: 0, del: 1 }]);
		expect(await listTree(work, changed!.tree)).toEqual([]);
	}, 20_000);
});
