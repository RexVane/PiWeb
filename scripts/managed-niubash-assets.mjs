import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const NIUBASH_VERSION = "1.1.4";
export const NIUBASH_TAG = `v${NIUBASH_VERSION}`;
export const NIUBASH_DISTRIBUTION_VERSION = `${NIUBASH_VERSION}-piweb.0`;
export const NIUBASH_REPOSITORY = "https://github.com/unixwin/niubash";

export const MANAGED_NIUBASH_ASSETS = Object.freeze({
	x64: Object.freeze({
		arch: "x64",
		machine: 0x8664,
		packageName: "@rexvane/piweb-niubash-win32-x64",
		directory: "piweb-niubash-win32-x64",
		asset: "niubash-v1.1.4-win-x64.zip",
		sha256: "9f543634288a316f7ed8e5a76ff794eca402cb21e74b8f8a551daffafde162f5",
	}),
	arm64: Object.freeze({
		arch: "arm64",
		machine: 0xaa64,
		packageName: "@rexvane/piweb-niubash-win32-arm64",
		directory: "piweb-niubash-win32-arm64",
		asset: "niubash-v1.1.4-win-arm64.zip",
		sha256: "77e98ba8d7f6be70c35388bcc28bdbc883c06bcaafffbe186a88788ad32ccf00",
	}),
});

export const NIUBASH_LICENSES = Object.freeze([
	Object.freeze({
		filename: "NIUBASH.txt",
		url: "https://raw.githubusercontent.com/unixwin/niubash/v1.1.4/LICENSE",
		sha256: "1290aae99e71239ee3154e7847830e49e7a36c758fa6d659d73fa752dc9f81c8",
	}),
	Object.freeze({
		filename: "RUBASH.txt",
		url: "https://raw.githubusercontent.com/unixwin/rubash/8b81c7501646/LICENSE",
		sha256: "e426a75a20633f3088da22aef61a5a44d06f1f884c600f6011d00702c3989079",
	}),
	Object.freeze({
		filename: "WINUXCMD.txt",
		url: "https://raw.githubusercontent.com/unixwin/WinuxCmd/v1.0.8/LICENSE",
		sha256: "8ffc4ed56f5e6ab8183a7ece2e3aa6ea4800b0a4e8170d11bd60856f2dd760f3",
	}),
]);

export function niubashAssetUrl(asset) {
	return `${NIUBASH_REPOSITORY}/releases/download/${NIUBASH_TAG}/${asset.asset}`;
}

export function sha256(data) {
	return crypto.createHash("sha256").update(data).digest("hex");
}

export function sha256File(filename) {
	return sha256(fs.readFileSync(filename));
}

export function listFiles(root) {
	const files = [];
	const visit = (directory, prefix = "") => {
		for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
			const absolute = path.join(directory, entry.name);
			if (entry.isDirectory()) visit(absolute, relative);
			else if (entry.isFile()) files.push(relative);
			else throw new Error(`managed niubash runtime contains an unsupported entry: ${relative}`);
		}
	};
	visit(root);
	return files;
}

export function readPeMachine(filename) {
	const data = fs.readFileSync(filename);
	if (data.length < 64 || data[0] !== 0x4d || data[1] !== 0x5a) throw new Error(`${filename} is not a PE executable`);
	const peOffset = data.readUInt32LE(0x3c);
	if (peOffset + 6 > data.length || data.toString("ascii", peOffset, peOffset + 4) !== "PE\0\0") {
		throw new Error(`${filename} has an invalid PE header`);
	}
	return data.readUInt16LE(peOffset + 4);
}

function readJson(filename) {
	return JSON.parse(fs.readFileSync(filename, "utf8"));
}

function assertEqual(actual, expected, label) {
	if (actual !== expected) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/** Validate a prepared source package or an unpacked npm tarball. */
export function validateManagedNiubashPackage(packageRoot, asset, { allowExtraRuntimeFiles = true } = {}) {
	const packageInfo = readJson(path.join(packageRoot, "package.json"));
	assertEqual(packageInfo.name, asset.packageName, "managed niubash package name");
	assertEqual(packageInfo.version, NIUBASH_DISTRIBUTION_VERSION, "managed niubash package version");
	if (!Array.isArray(packageInfo.os) || packageInfo.os.length !== 1 || packageInfo.os[0] !== "win32") {
		throw new Error(`${asset.packageName} must be restricted to os=win32`);
	}
	if (!Array.isArray(packageInfo.cpu) || packageInfo.cpu.length !== 1 || packageInfo.cpu[0] !== asset.arch) {
		throw new Error(`${asset.packageName} must be restricted to cpu=${asset.arch}`);
	}

	const runtime = path.join(packageRoot, "runtime");
	if (!fs.existsSync(path.join(runtime, "niu.exe"))) {
		throw new Error(`${asset.packageName} has no prepared runtime; run \`node scripts/prepare-niubash-packages.mjs\` before packing/publishing`);
	}
	const manifest = readJson(path.join(packageRoot, "runtime-manifest.json"));
	assertEqual(manifest.schema, 1, "managed niubash manifest schema");
	assertEqual(manifest.source?.repository, NIUBASH_REPOSITORY, "managed niubash source repository");
	assertEqual(manifest.source?.tag, NIUBASH_TAG, "managed niubash source tag");
	assertEqual(manifest.source?.asset, asset.asset, "managed niubash source asset");
	assertEqual(manifest.source?.sha256, asset.sha256, "managed niubash source SHA-256");
	if (!manifest.files || typeof manifest.files !== "object" || Array.isArray(manifest.files)) {
		throw new Error(`${asset.packageName} runtime manifest has no file map`);
	}
	const expectedFiles = Object.keys(manifest.files);
	if (expectedFiles.length < 300) throw new Error(`${asset.packageName} runtime is incomplete (${expectedFiles.length} files)`);
	for (const relative of expectedFiles) {
		if (!relative || relative.includes("\\") || path.posix.isAbsolute(relative) || relative.split("/").includes("..")) {
			throw new Error(`${asset.packageName} runtime manifest contains an unsafe path: ${relative}`);
		}
		const filename = path.join(runtime, ...relative.split("/"));
		const stat = fs.statSync(filename);
		if (!stat.isFile()) throw new Error(`${asset.packageName} runtime entry is not a file: ${relative}`);
		assertEqual(sha256File(filename), manifest.files[relative], `${asset.packageName} hash for ${relative}`);
	}
	const actualFiles = listFiles(runtime);
	const extra = actualFiles.filter((file) => !(file in manifest.files));
	if (!allowExtraRuntimeFiles && extra.length > 0) {
		throw new Error(
			`${asset.packageName} runtime has ${extra.length} files not in the signed manifest (niubash self-activates command links on first run). Re-run \`node scripts/prepare-niubash-packages.mjs\` before packing. First extra: ${extra[0]}`,
		);
	}

	for (const required of ["niu.exe", "winuxcmd/usr/bin/winuxcmd.exe", "bundles/oh-my-niu/bundle.toml"]) {
		if (!expectedFiles.includes(required)) throw new Error(`${asset.packageName} is missing ${required}`);
	}
	for (const executable of ["niu.exe", "winuxcmd/usr/bin/winuxcmd.exe"]) {
		assertEqual(readPeMachine(path.join(runtime, ...executable.split("/"))), asset.machine, `${asset.packageName} PE machine for ${executable}`);
	}
	for (const license of NIUBASH_LICENSES) {
		assertEqual(sha256File(path.join(packageRoot, "licenses", license.filename)), license.sha256, `${asset.packageName} license ${license.filename}`);
	}
	return { files: expectedFiles.length, runtime };
}
