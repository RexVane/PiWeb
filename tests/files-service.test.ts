import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { isSafeWindowsEditorArgument, listWorkspaceDir, readWorkspaceFile } from "../src/lib/files-service";

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
