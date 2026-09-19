import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createManagedNiubashTools, resolveManagedNiubash } from "../src/lib/managed-niubash";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const SPECS = {
	x64: {
		packageName: "@rexvane/piweb-niubash-win32-x64",
		asset: "niubash-v1.1.4-win-x64.zip",
		sha256: "9f543634288a316f7ed8e5a76ff794eca402cb21e74b8f8a551daffafde162f5",
		machine: 0x8664,
	},
	arm64: {
		packageName: "@rexvane/piweb-niubash-win32-arm64",
		asset: "niubash-v1.1.4-win-arm64.zip",
		sha256: "77e98ba8d7f6be70c35388bcc28bdbc883c06bcaafffbe186a88788ad32ccf00",
		machine: 0xaa64,
	},
} as const;

function sha256(data: Buffer) {
	return crypto.createHash("sha256").update(data).digest("hex");
}

function fakePe(machine: number) {
	const data = Buffer.alloc(256);
	data.write("MZ", 0, "ascii");
	data.writeUInt32LE(128, 0x3c);
	data.write("PE\0\0", 128, "ascii");
	data.writeUInt16LE(machine, 132);
	return data;
}

async function fixture(arch: keyof typeof SPECS, { directory = path.join("platform-packages", `piweb-niubash-win32-${arch}`) } = {}) {
	const spec = SPECS[arch];
	const root = await fs.mkdtemp(path.join(os.tmpdir(), `piweb-niubash-${arch}-`));
	cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
	const packageRoot = path.join(root, directory);
	await fs.mkdir(packageRoot, { recursive: true });
	const runtime = path.join(packageRoot, "runtime");
	await fs.mkdir(path.join(runtime, "winuxcmd", "usr", "bin"), { recursive: true });
	await fs.mkdir(path.join(runtime, "bundles", "oh-my-niu"), { recursive: true });
	await fs.writeFile(path.join(runtime, "niu.exe"), fakePe(spec.machine));
	await fs.writeFile(path.join(runtime, "winuxcmd", "usr", "bin", "winuxcmd.exe"), fakePe(spec.machine));
	await fs.writeFile(path.join(runtime, "bundles", "oh-my-niu", "bundle.toml"), "name = 'fixture'\n");
	for (let index = 0; index < 297; index += 1) {
		await fs.writeFile(path.join(runtime, "bundles", "oh-my-niu", `fixture-${String(index).padStart(3, "0")}.toml`), String(index));
	}

	const files: Record<string, string> = {};
	async function visit(directory: string, prefix = "") {
		for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
			const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (entry.isDirectory()) await visit(path.join(directory, entry.name), relative);
			else files[relative] = sha256(await fs.readFile(path.join(directory, entry.name)));
		}
	}
	await visit(runtime);
	await fs.writeFile(path.join(packageRoot, "package.json"), JSON.stringify({
		name: spec.packageName,
		version: "1.1.4-piweb.0",
		os: ["win32"],
		cpu: [arch],
	}));
	await fs.writeFile(path.join(packageRoot, "runtime-manifest.json"), JSON.stringify({
		schema: 1,
		source: {
			repository: "https://github.com/unixwin/niubash",
			tag: "v1.1.4",
			asset: spec.asset,
			sha256: spec.sha256,
		},
		files,
	}));
	await fs.mkdir(path.join(packageRoot, "licenses"));
	for (const name of ["NIUBASH.txt", "RUBASH.txt", "WINUXCMD.txt"]) {
		await fs.copyFile(path.join(process.cwd(), "third-party", "managed-niubash", "licenses", name), path.join(packageRoot, "licenses", name));
	}
	const value = {
		schema: 1,
		packageName: spec.packageName,
		distributionVersion: "1.1.4-piweb.0",
		niubashVersion: "1.1.4",
		platform: "win32",
		arch,
		runtimeDir: runtime,
		shellPath: path.join(runtime, "niu.exe"),
		manifestPath: path.join(packageRoot, "runtime-manifest.json"),
	};
	// 和真实平台包一样是 CommonJS 入口，便于直接测试仓库检出的解析路径。
	await fs.writeFile(path.join(packageRoot, "index.cjs"), `module.exports = ${JSON.stringify(value)};\n`);
	return { root, packageRoot, runtime, spec, value, loadPackage: () => ({ entryPath: path.join(packageRoot, "index.cjs"), value }) };
}

describe("managed niubash runtime", () => {
	it.each(["x64", "arm64"] as const)("validates the complete Windows %s package", async (arch) => {
		const packaged = await fixture(arch);
		const warnings: string[] = [];
		const resolved = resolveManagedNiubash({ platform: "win32", arch, loadPackage: packaged.loadPackage, warn: (message) => warnings.push(message) });
		expect(resolved).toMatchObject({ packageName: packaged.spec.packageName, arch, niubashVersion: "1.1.4" });
		expect(resolved?.shellPath).toBe(path.join(packaged.runtime, "niu.exe"));
		expect(warnings).toEqual([]);
	});

	it("provides a same-name bash tool so the SDK replaces its built-in definition", async () => {
		const packaged = await fixture("x64");
		const tools = createManagedNiubashTools(packaged.root, {
			platform: "win32",
			arch: "x64",
			loadPackage: packaged.loadPackage,
			warn: () => {},
		});
		expect(tools).toHaveLength(1);
		expect(tools[0].name).toBe("bash");
	});

	it("loads an unprepared package straight from a repository checkout", async () => {
		// 开发 / CI / 发布前的 runtime 准备都走这条约定路径；平台包尚未安装进 node_modules。
		const packaged = await fixture("x64");
		const warnings: string[] = [];
		const tools = createManagedNiubashTools(packaged.root, {
			platform: "win32",
			arch: "x64",
			root: packaged.root,
			warn: (message) => warnings.push(message),
		});
		expect(tools).toHaveLength(1);
		expect(warnings).toEqual([]);
	});

	it("reports a checkout that has no prepared runtime instead of throwing", async () => {
		const packaged = await fixture("x64");
		await fs.rm(packaged.packageRoot, { recursive: true, force: true });
		const warnings: string[] = [];
		expect(createManagedNiubashTools(packaged.root, {
			platform: "win32",
			arch: "x64",
			root: packaged.root,
			warn: (message) => warnings.push(message),
		})).toEqual([]);
		expect(warnings.join("\n")).toMatch(/not installed[\s\S]*configured\/default Bash/);
	});

	it("still validates after niubash self-activates extra command links", async () => {
		const packaged = await fixture("x64");
		await fs.writeFile(path.join(packaged.runtime, "winuxcmd", "usr", "bin", "ls.exe"), fakePe(SPECS.x64.machine));
		const warnings: string[] = [];
		expect(resolveManagedNiubash({
			platform: "win32",
			arch: "x64",
			loadPackage: packaged.loadPackage,
			warn: (message) => warnings.push(message),
		})).toMatchObject({ packageName: packaged.spec.packageName });
		expect(warnings).toEqual([]);
	});

	it("warns and falls back when any portable-runtime file is damaged", async () => {
		const packaged = await fixture("x64");
		await fs.appendFile(path.join(packaged.runtime, "bundles", "oh-my-niu", "bundle.toml"), "damaged");
		const warnings: string[] = [];
		expect(resolveManagedNiubash({
			platform: "win32",
			arch: "x64",
			loadPackage: packaged.loadPackage,
			warn: (message) => warnings.push(message),
		})).toBeNull();
		expect(warnings.join("\n")).toMatch(/integrity check[\s\S]*configured\/default Bash/);
	});

	it("does not load or warn on macOS/Linux", () => {
		let loaded = false;
		const warnings: string[] = [];
		expect(resolveManagedNiubash({
			platform: "linux",
			arch: "x64",
			loadPackage: () => { loaded = true; throw new Error("must not load"); },
			warn: (message) => warnings.push(message),
		})).toBeNull();
		expect(loaded).toBe(false);
		expect(warnings).toEqual([]);
	});

	it("warns and falls back for unsupported Windows architectures", () => {
		const warnings: string[] = [];
		expect(resolveManagedNiubash({ platform: "win32", arch: "ia32", warn: (message) => warnings.push(message) })).toBeNull();
		expect(warnings.join("\n")).toMatch(/does not support Windows ia32[\s\S]*configured\/default Bash/);
	});
});
