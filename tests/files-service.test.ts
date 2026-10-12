import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { isSafeWindowsEditorArgument, listWorkspaceDir, listWorkspaceIndex, parseLsFiles, readWorkspaceFile } from "../src/lib/files-service";
import { utf8Prefix } from "../src/lib/text-sanitize";

it("rejects cmd.exe metacharacters in editor arguments", () => {
	expect(isSafeWindowsEditorArgument("C:\\workspace\\file.txt")).toBe(true);
	expect(isSafeWindowsEditorArgument("C:\\workspace\\x&calc.exe")).toBe(false);
	expect(isSafeWindowsEditorArgument("C:\\workspace\\x%PATH%.txt")).toBe(false);
});

it("paginates a large directory without dropping files", async () => {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-files-page-"));
	try {
		await Promise.all(Array.from({ length: 2003 }, (_, index) => fs.writeFile(path.join(cwd, `file-${String(index).padStart(4, "0")}.txt`), "x")));
		const statSpy = vi.spyOn(fs, "stat");
		const first = await listWorkspaceDir(cwd, "", 0);
		expect(statSpy.mock.calls.some(([target]) => String(target).endsWith("file-2002.txt"))).toBe(false);
		statSpy.mockRestore();
		const second = await listWorkspaceDir(cwd, "", first.nextOffset);
		expect(first.entries).toHaveLength(2000);
		expect(first.nextOffset).toBe(2000);
		expect(first.entries[0]).toEqual({ name: "file-0000.txt", kind: "file", size: 1 });
		expect(second.entries).toHaveLength(3);
		expect(second.nextOffset).toBeNull();
		expect(second.entries[2]).toEqual({ name: "file-2002.txt", kind: "file", size: 1 });
		expect(new Set([...first.entries, ...second.entries].map((entry) => entry.name)).size).toBe(2003);
	} finally {
		vi.restoreAllMocks();
		if (path.dirname(cwd).toLowerCase() === os.tmpdir().toLowerCase() && path.basename(cwd).startsWith("piweb-files-page-")) {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	}
}, 20_000);

it("limits large file previews to 256 KiB", async () => {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-files-preview-"));
	try {
		await fs.writeFile(path.join(cwd, "large.txt"), "a".repeat(2 * 1024 * 1024));
		const preview = await readWorkspaceFile(cwd, "large.txt");
		expect(preview.binary).toBe(false);
		expect(preview.truncated).toBe(true);
		expect(preview.content).toHaveLength(256 * 1024);
	} finally {
		await fs.rm(cwd, { recursive: true, force: true });
	}
});

it("cuts a truncated preview on a character boundary, not in the middle of a UTF-8 sequence", async () => {
	// 回归：按字节截断把最后一个汉字切成半个，预览末尾出现 U+FFFD
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-files-utf8-"));
	try {
		// "ab" 之后每个汉字 3 字节，256 KiB 的边界正好落在一个汉字中间
		await fs.writeFile(path.join(cwd, "zh.txt"), `ab${"中".repeat(100_000)}`);
		const preview = await readWorkspaceFile(cwd, "zh.txt");
		expect(preview.truncated).toBe(true);
		expect(preview.content).not.toContain("�");
		expect(preview.content).toBe(`ab${"中".repeat(87_380)}`);
	} finally {
		await fs.rm(cwd, { recursive: true, force: true });
	}
	// 4 字节字符同理
	expect(utf8Prefix(Buffer.from("x😀"), 3).toString("utf8")).toBe("x");
	expect(utf8Prefix(Buffer.from("x😀"), 5).toString("utf8")).toBe("x😀");
});

it("sorts directory junctions with directories before paged files", async () => {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-files-junction-"));
	try {
		await fs.mkdir(path.join(cwd, "actual-dir"));
		await fs.symlink(path.join(cwd, "actual-dir"), path.join(cwd, "linked-dir"), process.platform === "win32" ? "junction" : "dir");
		await fs.writeFile(path.join(cwd, "file.txt"), "content");
		const listing = await listWorkspaceDir(cwd, "");
		expect(listing.entries).toEqual([
			{ name: "actual-dir", kind: "dir" },
			{ name: "linked-dir", kind: "dir" },
			{ name: "file.txt", kind: "file", size: 7 },
		]);
	} finally {
		await fs.rm(cwd, { recursive: true, force: true });
	}
});

it("indexes git-visible files for @ references, honoring .gitignore", async () => {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-files-index-"));
	try {
		execFileSync("git", ["init", "-q", cwd], { windowsHide: true });
		await fs.writeFile(path.join(cwd, ".gitignore"), "ignored.txt\nnode_modules/\n");
		await fs.mkdir(path.join(cwd, "src", "app"), { recursive: true });
		await fs.writeFile(path.join(cwd, "tracked.txt"), "tracked\n");
		execFileSync("git", ["-C", cwd, "add", "tracked.txt"], { windowsHide: true });
		await fs.writeFile(path.join(cwd, "untracked.txt"), "untracked\n");
		await fs.writeFile(path.join(cwd, "src", "app", "main.ts"), "main\n");
		await fs.writeFile(path.join(cwd, "ignored.txt"), "ignored\n");
		await fs.mkdir(path.join(cwd, "node_modules", "pkg"), { recursive: true });
		await fs.writeFile(path.join(cwd, "node_modules", "pkg", "index.js"), "ignored\n");

		const index = await listWorkspaceIndex(cwd);
		expect(index.source).toBe("git");
		expect(index.truncated).toBe(false);
		expect(index.files).toEqual([".gitignore", "src/app/main.ts", "tracked.txt", "untracked.txt"]);
		expect(index.files.some((file) => file.includes("node_modules"))).toBe(false);
	} finally {
		await fs.rm(cwd, { recursive: true, force: true });
	}
}, 30_000);

it("surfaces git failures other than 'not a repository' instead of silently walking the disk", async () => {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-files-broken-"));
	try {
		execFileSync("git", ["init", "-q", cwd], { windowsHide: true });
		// LC_ALL=C 只让报错固定成英文，非 ASCII 路径照常
		await fs.writeFile(path.join(cwd, "中文 文件.txt"), "x");
		expect((await listWorkspaceIndex(cwd)).files).toEqual(["中文 文件.txt"]);

		await fs.writeFile(path.join(cwd, ".git", "index"), "not an index");
		await expect(listWorkspaceIndex(cwd)).rejects.toThrow(/^git ls-files failed: fatal: .*index/);
	} finally {
		await fs.rm(cwd, { recursive: true, force: true });
	}
}, 30_000);

it("falls back to a directory walk outside git, skipping heavy directories and capping depth", async () => {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-files-disk-"));
	try {
		await fs.mkdir(path.join(cwd, "src", "deep"), { recursive: true });
		await fs.writeFile(path.join(cwd, "src", "deep", "file.ts"), "x");
		await fs.mkdir(path.join(cwd, "node_modules", "pkg"), { recursive: true });
		await fs.writeFile(path.join(cwd, "node_modules", "pkg", "index.js"), "x");
		const beyond = path.join(cwd, ...Array.from({ length: 14 }, (_, i) => `d${i}`));
		await fs.mkdir(beyond, { recursive: true });
		await fs.writeFile(path.join(beyond, "too-deep.ts"), "x");

		const index = await listWorkspaceIndex(cwd);
		expect(index.source).toBe("disk");
		expect(index.files).toContain("src/deep/file.ts");
		expect(index.files.some((file) => file.includes("node_modules"))).toBe(false);
		expect(index.files).not.toContain(`${Array.from({ length: 14 }, (_, i) => `d${i}`).join("/")}/too-deep.ts`);
	} finally {
		await fs.rm(cwd, { recursive: true, force: true });
	}
}, 30_000);

it("parses ls-files output into safe workspace-relative paths", () => {
	expect(parseLsFiles("b.ts\0a.ts\0b.ts\0src\\win.ts\0../escape.ts\0/etc/passwd\0")).toEqual(["b.ts", "a.ts", "src/win.ts"]);
	expect(parseLsFiles("")).toEqual([]);
});
