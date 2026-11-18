import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveModelPath } from "@/lib/path-security";
import { recycleFixture } from "../fixtures/recycle";

const win32 = process.platform === "win32";

let base: string;
let workspace: string;
let outside: string;

beforeAll(async () => {
	base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "piweb-resolve-model-path-")));
	await fs.mkdir(path.join(base, "workspace", "src"), { recursive: true });
	await fs.mkdir(path.join(base, "outside"), { recursive: true });
	workspace = await fs.realpath(path.join(base, "workspace"));
	outside = await fs.realpath(path.join(base, "outside"));
});

afterAll(async () => {
	await recycleFixture(base);
});

describe("resolveModelPath", () => {
	it("resolves like pi's tools: cwd for relative paths, keeps absolute ones", () => {
		expect(resolveModelPath("src/a.ts", workspace)).toBe(path.join(workspace, "src", "a.ts"));
		expect(resolveModelPath(path.join(outside, "b.ts"), workspace)).toBe(path.join(outside, "b.ts"));
		expect(resolveModelPath("../x.ts", workspace)).toBe(path.join(base, "x.ts"));
	});

	it("strips the @ prefix, expands ~ and normalizes unicode spaces", () => {
		const home = path.join(base, "home");
		expect(resolveModelPath("@src/a.ts", workspace)).toBe(path.join(workspace, "src", "a.ts"));
		expect(resolveModelPath("~/notes.md", workspace, home)).toBe(path.join(home, "notes.md"));
		expect(resolveModelPath("~", workspace, home)).toBe(home);
		expect(resolveModelPath("my\u00A0file.ts", workspace)).toBe(path.join(workspace, "my file.ts"));
	});

	it("normalizes shell drive spellings consistently with the SDK", () => {
		if (!win32) {
			expect(resolveModelPath("/mnt/c/outside.txt", workspace)).toBe("/mnt/c/outside.txt");
			return;
		}
		for (const name of ["/c/outside.txt", "/mnt/c/outside.txt", "/cygdrive/c/outside.txt"]) {
			expect(resolveModelPath(name, workspace)).toBe("C:\\outside.txt");
		}
		const drivePath = workspace.replaceAll("\\", "/").replace(/^([a-z]):/i, (_, letter) => `/mnt/${letter.toLowerCase()}`);
		expect(resolveModelPath(`${drivePath}/src/inside.txt`, workspace)).toBe(path.join(workspace, "src", "inside.txt"));
	});
});
