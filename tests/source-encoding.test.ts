import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT_FILES = [".editorconfig", ".gitattributes", "AGENTS.md", "next.config.ts", "package.json", "tsconfig.json"];
const SOURCE_DIRS = ["bin", "scripts", "src", "tests"];
const TEXT_EXTENSIONS = new Set([".css", ".js", ".json", ".md", ".mjs", ".ps1", ".ts", ".tsx"]);

async function collectTextFiles(dir: string): Promise<string[]> {
	const files: string[] = [];
	for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
		const target = path.join(dir, entry.name);
		if (entry.isDirectory()) files.push(...await collectTextFiles(target));
		else if (TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) files.push(target);
	}
	return files;
}

describe("repository text encoding", () => {
	it("keeps application sources valid UTF-8", async () => {
		const root = process.cwd();
		const files = [
			...ROOT_FILES.map((file) => path.join(root, file)),
			...(await Promise.all(SOURCE_DIRS.map((dir) => collectTextFiles(path.join(root, dir))))).flat(),
		];
		const decoder = new TextDecoder("utf-8", { fatal: true });

		for (const file of files) {
			const bytes = await fs.readFile(file);
			expect(() => decoder.decode(bytes), path.relative(root, file)).not.toThrow();
		}
	});
});
