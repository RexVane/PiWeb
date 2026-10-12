import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { completeFiles } from "../src/lib/file-completion-service";
import { getAgentDir } from "../src/lib/pi";

// pi downloads fd on first CLI startup. Clean CI installs may not have run the CLI.
const binaryNames = process.platform === "win32" ? ["fd.exe", "fdfind.exe"] : ["fd", "fdfind"];
const searchDirs = [path.join(getAgentDir(), "bin"), ...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean)];
const hasFd = (await Promise.all(searchDirs.flatMap((dir) => binaryNames.map(async (name) => {
	const binary = path.join(dir, name);
	try {
		await fs.access(binary, fs.constants.X_OK);
		return (await fs.stat(binary)).isFile();
	} catch { return false; }
})))).some(Boolean);
const integrationTest = it.skipIf(!hasFd);

const fixtures: string[] = [];
afterEach(async () => {
	vi.unstubAllEnvs();
	await Promise.all(fixtures.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function workspace() {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-completion-"));
	fixtures.push(cwd);
	await fs.mkdir(path.join(cwd, "src"));
	await fs.mkdir(path.join(cwd, ".git"));
	await fs.writeFile(path.join(cwd, "src", "hello world.ts"), "export {};");
	await fs.writeFile(path.join(cwd, "src", "hidden.ts"), "export {};");
	await fs.writeFile(path.join(cwd, ".gitignore"), "src/hidden.ts\n");
	return cwd;
}

integrationTest("uses pi search and replacement for nested files, quoted paths, and a cursor in the middle", async () => {
	const cwd = await workspace();
	const text = "第一行\nreview @hello then explain";
	const cursor = text.indexOf(" then");
	const result = await completeFiles(cwd, text, cursor, new AbortController().signal);
	expect(result.prefix).toBe("@hello");
	expect(result.items).toContainEqual(expect.objectContaining({
		label: "hello world.ts", value: '@"src/hello world.ts"',
		text: '第一行\nreview @"src/hello world.ts"  then explain',
		cursor: '第一行\nreview @"src/hello world.ts" '.length,
	}));
	expect((await completeFiles(cwd, "@hidden", 7, new AbortController().signal)).items).toEqual([]);
});

integrationTest("keeps directory completion open and can complete a file within it", async () => {
	const cwd = await workspace();
	const result = await completeFiles(cwd, "@sr", 3, new AbortController().signal);
	expect(result.items).toContainEqual(expect.objectContaining({ label: "src/", text: "@src/", cursor: 5 }));
	const nested = await completeFiles(cwd, '@"src/hello', 11, new AbortController().signal);
	expect(nested.items).toContainEqual(expect.objectContaining({ text: '@"src/hello world.ts" ', cursor: 22 }));
});

integrationTest("ignores email addresses", async () => {
	const cwd = await workspace();
	expect((await completeFiles(cwd, "name@example.com", 16, new AbortController().signal)).items).toEqual([]);
});

it("validates the workspace and cursor before looking for fd", async () => {
	const cwd = await workspace();
	await expect(completeFiles(cwd, "@", 2, new AbortController().signal)).rejects.toThrow("invalid file completion input");
	await expect(completeFiles(path.join(cwd, "missing"), "@", 1, new AbortController().signal)).rejects.toThrow("workspace not found");
});

it("reports how to install the file search tool when fd is unavailable", async () => {
	const cwd = await workspace();
	vi.stubEnv("PI_CODING_AGENT_DIR", cwd);
	vi.stubEnv("PATH", "");
	await expect(completeFiles(cwd, "@", 1, new AbortController().signal)).rejects.toThrow("File search requires fd");
});
