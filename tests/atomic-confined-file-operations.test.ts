import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { createConfinedFileOperations } from "@/lib/confined-file-operations";
import { aclOf, recycleFixture } from "./lib/sandbox/fixtures";

const sandboxFor = vi.fn(async () => null);
vi.mock("@/lib/sandbox/manager", () => ({ sandboxFor }));
vi.mock("@/lib/sandbox/config", () => ({ readSandboxConfig: vi.fn(async () => ({ additionalWritableRoots: [] })) }));

it.skipIf(process.platform !== "win32")("pins Windows directories while creating and replacing files without a shell backend", async () => {
	const base = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-confined-atomic-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	try {
		process.env.PI_CODING_AGENT_DIR = path.join(base, "agent");
		const workspace = path.join(base, "workspace");
		await fs.mkdir(workspace);
		const operations = createConfinedFileOperations({ sessionPath: "atomic", cwd: workspace, preset: () => "workspace" });
		await operations.mkdir(path.join(workspace, "nested"));
		const target = path.join(workspace, "nested", "new.txt");
		await operations.writeFile(target, "first");
		expect(await fs.readFile(target, "utf8")).toBe("first");
		await operations.writeFile(target, "replacement");
		expect(await fs.readFile(target, "utf8")).toBe("replacement");
		expect(await fs.readdir(path.dirname(target))).toEqual(["new.txt"]);
		expect(sandboxFor).not.toHaveBeenCalled();
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
		await recycleFixture(base);
	}
});

it.skipIf(process.platform !== "win32")("edits source in a pnpm-style hard-linked workspace without changing dependency ACLs", async () => {
	const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "piweb-confined-hardlinks-")));
	try {
		const workspace = path.join(base, "workspace");
		const dependency = path.join(workspace, "node_modules", "package", "index.js");
		const external = path.join(base, "store.js");
		await fs.mkdir(path.dirname(dependency), { recursive: true });
		await fs.writeFile(external, "external dependency");
		await fs.link(external, dependency);
		const acl = await aclOf(external);
		const operations = createConfinedFileOperations({ sessionPath: "pnpm", cwd: workspace, preset: () => "workspace" });
		const readdir = vi.spyOn(fs, "readdir");
		try {
			await operations.writeFile(path.join(workspace, "source.ts"), "safe source edit");
			expect(readdir).not.toHaveBeenCalled();
		} finally { readdir.mockRestore(); }
		await expect(operations.writeFile(dependency, "mutate alias")).rejects.toThrow(/blocked/);
		expect(await fs.readFile(path.join(workspace, "source.ts"), "utf8")).toBe("safe source edit");
		expect(await fs.readFile(external, "utf8")).toBe("external dependency");
		expect(await aclOf(external)).toBe(acl);
	} finally { await recycleFixture(base); }
});

it.skipIf(process.platform !== "win32")("prevents ancestor replacement during an in-flight Windows write", async () => {
	const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "piweb-confined-race-")));
	try {
		const workspace = path.join(base, "workspace");
		const parent = path.join(workspace, "nested");
		await fs.mkdir(parent, { recursive: true });
		const operations = createConfinedFileOperations({ sessionPath: "race", cwd: workspace, preset: () => "workspace" });
		const writeFile = fs.writeFile.bind(fs);
		let attempted = false;
		const spy = vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
			if (String(args[0]).includes(".piweb-write-")) {
				attempted = true;
				await expect(fs.rename(parent, path.join(workspace, "moved"))).rejects.toMatchObject({ code: expect.stringMatching(/EPERM|EBUSY/) });
				await expect(fs.rename(workspace, path.join(base, "moved-workspace"))).rejects.toMatchObject({ code: expect.stringMatching(/EPERM|EBUSY/) });
			}
			return writeFile(...args);
		});
		try { await operations.writeFile(path.join(parent, "file.txt"), "inside"); }
		finally { spy.mockRestore(); }
		expect(attempted).toBe(true);
		expect(await fs.readFile(path.join(parent, "file.txt"), "utf8")).toBe("inside");
		// Handles are released after completion, rather than locking the user's tree forever.
		await fs.rename(parent, path.join(workspace, "moved"));
	} finally { await recycleFixture(base); }
});

it.skipIf(process.platform !== "win32")("rejects readonly and outside junction writes without starting a Windows command", async () => {
	const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "piweb-confined-boundary-")));
	try {
		const workspace = path.join(base, "workspace");
		const outside = path.join(base, "outside");
		await fs.mkdir(workspace);
		await fs.mkdir(outside);
		await fs.symlink(outside, path.join(workspace, "junction"), "junction");
		const operations = createConfinedFileOperations({ sessionPath: "boundary", cwd: workspace, preset: () => "workspace" });
		await expect(operations.writeFile(path.join(workspace, "junction", "x"), "no")).rejects.toThrow(/outside/);
		const readonly = createConfinedFileOperations({ sessionPath: "readonly", cwd: workspace, preset: () => "readonly" });
		await expect(readonly.writeFile(path.join(workspace, "x"), "no")).rejects.toThrow(/readonly/);
		expect(await fs.readdir(outside)).toEqual([]);
		expect(sandboxFor).not.toHaveBeenCalled();
	} finally { await recycleFixture(base); }
});

it.skipIf(process.platform !== "win32")("keeps the original file when permission is lowered before atomic replacement", async () => {
	const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "piweb-confined-downgrade-")));
	try {
		const target = path.join(base, "original.txt");
		await fs.writeFile(target, "original");
		let preset: "workspace" | "readonly" = "workspace";
		const operations = createConfinedFileOperations({ sessionPath: "downgrade", cwd: base, preset: () => preset });
		const writeFile = fs.writeFile.bind(fs);
		const spy = vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
			await writeFile(...args);
			if (String(args[0]).includes(".piweb-write-")) preset = "readonly";
		});
		try { await expect(operations.writeFile(target, "replacement")).rejects.toThrow(/permission preset changed/); }
		finally { spy.mockRestore(); }
		expect(await fs.readFile(target, "utf8")).toBe("original");
		expect(await fs.readdir(base)).toEqual(["original.txt"]);
	} finally { await recycleFixture(base); }
});
