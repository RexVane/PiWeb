import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gitInfo } from "../src/lib/git-service";
import { commitRound, fileContent, listTree, recordWorkspaceChanges } from "../src/lib/growth-service";
import { recycleFixture } from "./fixtures/recycle";

// PIWEB_LARGE_WORKSPACE_TESTS=1 npm test -- tests/growth-large-workspace.stress.ts
describe("large project recording", () => {
	let root: string;
	let work: string;
	const options = { allowRecording: true };
	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-scale-"));
		work = path.join(root, "workspace");
		await fs.mkdir(work);
		vi.stubEnv("PI_CODING_AGENT_DIR", path.join(root, "agent"));
	});
	afterEach(async () => {
		vi.unstubAllEnvs();
		if (process.platform === "darwin") {
			execFileSync("osascript", ["-e", "on run argv\ntell application \"Finder\" to delete (POSIX file (item 1 of argv) as alias)\nend run", root]);
		} else await recycleFixture(root);
	});

	it("records every path when 24,000 small files produce more than 8 MiB of pathnames", async () => {
		let pathBytes = 0;
		for (let group = 0; group < 40; group++) {
			const dir = path.join("区".repeat(34) + group, "目".repeat(34));
			await fs.mkdir(path.join(work, dir), { recursive: true });
			for (let start = 0; start < 600; start += 50) {
				await Promise.all(Array.from({ length: 50 }, (_, offset) => {
					const relative = path.join(dir, `${"源".repeat(57)}-${start + offset}.ts`);
					pathBytes += Buffer.byteLength(relative) + 1;
					return fs.writeFile(path.join(work, relative), "export {};\n");
				}));
			}
		}
		expect(pathBytes).toBeGreaterThan(8 * 1024 * 1024);
		const baseline = (await recordWorkspaceChanges(work, "paths.jsonl", options))!;
		expect(await listTree(work, baseline.tree)).toHaveLength(24_000);
		await expect(fs.stat(path.join(work, ".git"))).rejects.toMatchObject({ code: "ENOENT" });
		execFileSync("git", ["init", "--quiet", work]);
		const summary = await gitInfo(work, true);
		expect(summary).toMatchObject({ counts: { total: 24_000, untracked: 24_000 }, files: [], commits: [] });
		expect(summary.statusError).toBeUndefined();
	}, 240_000);

	it("captures two changes against an 800 MiB source baseline and leaves the user index intact", async () => {
		const text = "// a line of source documentation\n".repeat(32_768).slice(0, 1024 * 1024);
		for (let start = 0; start < 800; start += 16) {
			await Promise.all(Array.from({ length: 16 }, (_, offset) => {
				const id = String(start + offset).padStart(3, "0");
				return fs.writeFile(path.join(work, `module-${id}.js`), `//${id}\n` + text.slice(6));
			}));
		}
		const git = (args: string[]) => execFileSync("git", ["-C", work, ...args], { encoding: "utf8" }).trim();
		git(["init", "--quiet"]);
		git(["add", "--", "module-000.js"]);
		const staged = git(["ls-files", "--stage"]);
		const base = (await recordWorkspaceChanges(work, "source.jsonl", options))!;
		const files = await listTree(work, base.tree);
		expect(files.reduce((total, file) => total + file.size, 0)).toBe(800 * 1024 * 1024);
		expect(git(["rev-parse", base.tree + ":module-000.js"])).toBe(git(["rev-parse", ":module-000.js"]));
		await fs.writeFile(path.join(work, "module-000.js"), "export const first = true;\n");
		await fs.writeFile(path.join(work, "module-799.js"), "export const last = true;\n");
		const round = (await commitRound(work, { kind: "round", session: "source.jsonl" }, options))!;
		expect(round.parent).toBe(base.commit);
		expect(round.changes.map((change) => [change.path, change.status])).toEqual([["module-000.js", "M"], ["module-799.js", "M"]]);
		expect((await fileContent(work, round.tree, "module-799.js")).content).toContain("last = true");
		expect(git(["ls-files", "--stage"])).toBe(staged);
	}, 240_000);
});
