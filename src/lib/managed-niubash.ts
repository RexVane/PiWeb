import crypto from "node:crypto";
import fs from "node:fs";
import * as nodeModule from "node:module";
import path from "node:path";
import { createBashToolDefinition, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { APP_ROOT } from "./app-root";

const DISTRIBUTION_VERSION = "1.1.4-piweb.0";
const NIUBASH_VERSION = "1.1.4";
const SOURCE_REPOSITORY = "https://github.com/unixwin/niubash";
const SOURCE_TAG = "v1.1.4";

const PACKAGE_BY_ARCH = {
	x64: {
		packageName: "@rexvane/piweb-niubash-win32-x64",
		directory: "piweb-niubash-win32-x64",
		asset: "niubash-v1.1.4-win-x64.zip",
		assetSha256: "9f543634288a316f7ed8e5a76ff794eca402cb21e74b8f8a551daffafde162f5",
		machine: 0x8664,
	},
	arm64: {
		packageName: "@rexvane/piweb-niubash-win32-arm64",
		directory: "piweb-niubash-win32-arm64",
		asset: "niubash-v1.1.4-win-arm64.zip",
		assetSha256: "77e98ba8d7f6be70c35388bcc28bdbc883c06bcaafffbe186a88788ad32ccf00",
		machine: 0xaa64,
	},
} as const;

const LICENSE_HASHES = {
	"NIUBASH.txt": "1290aae99e71239ee3154e7847830e49e7a36c758fa6d659d73fa752dc9f81c8",
	"RUBASH.txt": "e426a75a20633f3088da22aef61a5a44d06f1f884c600f6011d00702c3989079",
	"WINUXCMD.txt": "8ffc4ed56f5e6ab8183a7ece2e3aa6ea4800b0a4e8170d11bd60856f2dd760f3",
} as const;

export type SupportedArch = keyof typeof PACKAGE_BY_ARCH;

type PackageExport = {
	schema?: unknown;
	packageName?: unknown;
	distributionVersion?: unknown;
	niubashVersion?: unknown;
	platform?: unknown;
	arch?: unknown;
	runtimeDir?: unknown;
	shellPath?: unknown;
	manifestPath?: unknown;
};

type LoadedPackage = { entryPath: string; value: unknown };

/**
 * npm 安装（全局或本地）普通情况下由 Node 解析：npm 会把可选包提升到任意祖先
 * node_modules，所以解析必须从包自己的 package.json 出发。仓库检出（开发 / CI /
 * 发布前的 runtime 准备）没有安装这一步，此时按约定找 platform-packages/<dir>——
 * 这与平台包发布后的目录布局一一对应，不引入第二套解析规则。
 */
export function resolveManagedNiubashPackageEntry(packageName: string, arch: SupportedArch, root = APP_ROOT): LoadedPackage {
	// 必须通过命名空间调用。webpack 会改写从 node:module 具名导入的 createRequire：
	// 参数不是字符串字面量时把调用擦掉，运行时变成对 undefined 调用 resolve。
	const loadPackage = nodeModule.createRequire(path.join(root, "package.json"));
	const resolveEntry = loadPackage.resolve.bind(loadPackage);
	try {
		const entryPath = resolveEntry(packageName);
		return { entryPath, value: loadPackage(packageName) };
	} catch (error) {
		const checkoutEntry = path.join(root, "platform-packages", PACKAGE_BY_ARCH[arch].directory, "index.cjs");
		if (fs.existsSync(checkoutEntry)) return { entryPath: checkoutEntry, value: loadPackage(checkoutEntry) };
		throw error;
	}
}

export type ManagedNiubashRuntime = {
	packageName: string;
	distributionVersion: string;
	niubashVersion: string;
	arch: SupportedArch;
	runtimeDir: string;
	shellPath: string;
};

export type ManagedNiubashResolveOptions = {
	platform?: string;
	arch?: string;
	/** Base for package resolution; tests and the prepare script point it at a checkout root. */
	root?: string;
	loadPackage?: (packageName: string, arch: SupportedArch) => LoadedPackage;
	warn?: (message: string) => void;
};

function sha256File(filename: string): string {
	return crypto.createHash("sha256").update(fs.readFileSync(filename)).digest("hex");
}

function readJson(filename: string): any {
	const stat = fs.statSync(filename);
	if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error(`${path.basename(filename)} is missing or too large`);
	return JSON.parse(fs.readFileSync(filename, "utf8"));
}

function samePath(left: string, right: string): boolean {
	const a = path.resolve(left);
	const b = path.resolve(right);
	return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function peMachine(filename: string): number {
	const data = fs.readFileSync(filename);
	if (data.length < 64 || data[0] !== 0x4d || data[1] !== 0x5a) throw new Error(`${path.basename(filename)} is not a PE executable`);
	const offset = data.readUInt32LE(0x3c);
	if (offset + 6 > data.length || data.toString("ascii", offset, offset + 4) !== "PE\0\0") {
		throw new Error(`${path.basename(filename)} has an invalid PE header`);
	}
	return data.readUInt16LE(offset + 4);
}

function validatePackage(loaded: LoadedPackage, arch: SupportedArch): ManagedNiubashRuntime {
	const expected = PACKAGE_BY_ARCH[arch];
	if (!loaded.value || typeof loaded.value !== "object") throw new Error(`${expected.packageName} has no runtime export`);
	const exported = loaded.value as PackageExport;
	const packageRoot = path.dirname(path.resolve(loaded.entryPath));
	const runtimeDir = path.join(packageRoot, "runtime");
	const shellPath = path.join(runtimeDir, "niu.exe");
	const manifestPath = path.join(packageRoot, "runtime-manifest.json");

	const checks: Array<[unknown, unknown, string]> = [
		[exported.schema, 1, "export schema"],
		[exported.packageName, expected.packageName, "export package name"],
		[exported.distributionVersion, DISTRIBUTION_VERSION, "export distribution version"],
		[exported.niubashVersion, NIUBASH_VERSION, "export niubash version"],
		[exported.platform, "win32", "export platform"],
		[exported.arch, arch, "export architecture"],
	];
	for (const [actual, wanted, label] of checks) {
		if (actual !== wanted) throw new Error(`${label} mismatch`);
	}
	if (typeof exported.runtimeDir !== "string" || !samePath(exported.runtimeDir, runtimeDir)) throw new Error("runtime directory escapes its package");
	if (typeof exported.shellPath !== "string" || !samePath(exported.shellPath, shellPath)) throw new Error("shell path escapes its package");
	if (typeof exported.manifestPath !== "string" || !samePath(exported.manifestPath, manifestPath)) throw new Error("manifest path escapes its package");

	const packageInfo = readJson(path.join(packageRoot, "package.json"));
	if (packageInfo.name !== expected.packageName || packageInfo.version !== DISTRIBUTION_VERSION) throw new Error("package identity mismatch");
	if (packageInfo.os?.length !== 1 || packageInfo.os[0] !== "win32") throw new Error("package OS restriction mismatch");
	if (packageInfo.cpu?.length !== 1 || packageInfo.cpu[0] !== arch) throw new Error("package CPU restriction mismatch");

	const manifest = readJson(manifestPath);
	if (manifest.schema !== 1
		|| manifest.source?.repository !== SOURCE_REPOSITORY
		|| manifest.source?.tag !== SOURCE_TAG
		|| manifest.source?.asset !== expected.asset
		|| manifest.source?.sha256 !== expected.assetSha256) {
		throw new Error("runtime provenance mismatch");
	}
	if (!manifest.files || typeof manifest.files !== "object" || Array.isArray(manifest.files)) throw new Error("runtime file manifest is missing");
	const files = Object.entries(manifest.files) as Array<[string, unknown]>;
	if (files.length < 300 || files.length > 1000) throw new Error(`runtime file count is invalid (${files.length})`);
	for (const [relative, digest] of files) {
		if (!relative || relative.includes("\\") || path.posix.isAbsolute(relative) || /^[A-Za-z]:/.test(relative) || relative.split("/").includes("..")) {
			throw new Error(`unsafe runtime path: ${relative}`);
		}
		if (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)) throw new Error(`invalid runtime hash: ${relative}`);
		const filename = path.join(runtimeDir, ...relative.split("/"));
		if (!fs.statSync(filename).isFile()) throw new Error(`runtime file is missing: ${relative}`);
		if (sha256File(filename) !== digest) throw new Error(`runtime file failed integrity check: ${relative}`);
	}
	for (const required of ["niu.exe", "winuxcmd/usr/bin/winuxcmd.exe", "bundles/oh-my-niu/bundle.toml"]) {
		if (!(required in manifest.files)) throw new Error(`runtime file is missing: ${required}`);
	}
	for (const executable of [shellPath, path.join(runtimeDir, "winuxcmd", "usr", "bin", "winuxcmd.exe")]) {
		if (peMachine(executable) !== expected.machine) throw new Error(`${path.basename(executable)} architecture mismatch`);
	}
	for (const [name, digest] of Object.entries(LICENSE_HASHES)) {
		if (sha256File(path.join(packageRoot, "licenses", name)) !== digest) throw new Error(`license integrity check failed: ${name}`);
	}

	return Object.freeze({
		packageName: expected.packageName,
		distributionVersion: DISTRIBUTION_VERSION,
		niubashVersion: NIUBASH_VERSION,
		arch,
		runtimeDir,
		shellPath,
	});
}

function reasonOf(error: unknown, packageName: string): string {
	if ((error as NodeJS.ErrnoException | undefined)?.code === "MODULE_NOT_FOUND") return `${packageName} is not installed`;
	return error instanceof Error ? error.message : String(error);
}

/** Resolve and fully validate the platform package. Failures deliberately fall back to Pi's normal Bash. */
export function resolveManagedNiubash(options: ManagedNiubashResolveOptions = {}): ManagedNiubashRuntime | null {
	const platform = options.platform ?? process.platform;
	const arch = options.arch ?? process.arch;
	if (platform !== "win32") return null;
	const expected = PACKAGE_BY_ARCH[arch as SupportedArch];
	if (!expected) {
		(options.warn ?? console.warn)(`[piweb] Managed niubash does not support Windows ${arch}; using Pi's configured/default Bash.`);
		return null;
	}
	const supported = arch as SupportedArch;
	try {
		const loaded = options.loadPackage
			? options.loadPackage(expected.packageName, supported)
			: resolveManagedNiubashPackageEntry(expected.packageName, supported, options.root);
		return validatePackage(loaded, supported);
	} catch (error) {
		(options.warn ?? console.warn)(
			`[piweb] Managed niubash is unavailable (${reasonOf(error, expected.packageName)}); using Pi's configured/default Bash. `
			+ "Reinstall @rexvane/piweb to restore the bundled Windows shell (`npm run prepare:niubash` in a checkout).",
		);
		return null;
	}
}

const globalForManagedNiubash = globalThis as typeof globalThis & {
	__piWebManagedNiubash?: { resolved: ManagedNiubashRuntime | null };
};

function defaultRuntime(): ManagedNiubashRuntime | null {
	if (!globalForManagedNiubash.__piWebManagedNiubash) {
		globalForManagedNiubash.__piWebManagedNiubash = { resolved: resolveManagedNiubash() };
	}
	return globalForManagedNiubash.__piWebManagedNiubash.resolved;
}

/** Same-name custom tool intentionally replaces Pi's built-in bash only inside PiWeb sessions. */
export function createManagedNiubashTools(cwd: string, options?: ManagedNiubashResolveOptions): ToolDefinition[] {
	const runtime = options ? resolveManagedNiubash(options) : defaultRuntime();
	return runtime ? [createBashToolDefinition(cwd, { shellPath: runtime.shellPath }) as ToolDefinition] : [];
}
