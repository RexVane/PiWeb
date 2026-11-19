import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { GET } from "../src/app/api/files/route";
import { recycleFixture } from "./fixtures/recycle";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it("/api/files distinguishes outside, missing and directory paths, retaining realpath checks", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-file-boundary-codes-"));
	vi.stubEnv("PIWEB_FS_STRICT_WORKSPACES", "0");
	const root = path.join(dir, "workspace");
	const outside = path.join(dir, "outside");
	const read = (target: string) => GET(new Request(`http://localhost/api/files?${new URLSearchParams({ read: "1", cwd: root, path: target })}`));
	try {
		await fs.mkdir(root);
		await fs.mkdir(outside);
		await fs.writeFile(path.join(root, "inside.txt"), "content");
		await fs.writeFile(path.join(outside, "exists.txt"), "still exists");
		await fs.symlink(outside, path.join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
		for (const target of ["../outside/exists.txt", path.join(outside, "exists.txt"), "linked/exists.txt"]) {
			const response = await read(target);
			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({ success: false, errorCode: "OUT_OF_WORKSPACE" });
		}
		expect(await fs.readFile(path.join(outside, "exists.txt"), "utf8")).toBe("still exists");
		expect(await (await read("missing.txt")).json()).toMatchObject({ errorCode: "NOT_FOUND" });
		expect(await (await read(".")).json()).toMatchObject({ errorCode: "NOT_A_FILE" });
		expect(await (await read(path.join(root, "inside.txt"))).json()).toMatchObject({ success: true, data: { content: "content" } });
	} finally {
		await recycleFixture(dir);
	}
});

it("directory permission errors are not converted into NOT_FOUND", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-file-permission-codes-"));
	vi.stubEnv("PIWEB_FS_STRICT_WORKSPACES", "0");
	try {
		const realpath = fs.realpath.bind(fs);
		vi.spyOn(fs, "realpath").mockImplementation(async (target, ...args) => {
			if (String(target) === path.join(dir, "denied")) throw Object.assign(new Error("private path"), { code: "EACCES" });
			return realpath(target, ...args);
		});
		const response = await GET(new Request(`http://localhost/api/files?${new URLSearchParams({ cwd: dir, path: "denied" })}`));
		expect(await response.json()).toMatchObject({ success: false, errorCode: "EACCES" });
	} finally {
		vi.restoreAllMocks();
		await recycleFixture(dir);
	}
});
