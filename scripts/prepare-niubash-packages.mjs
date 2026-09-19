#!/usr/bin/env node
/**
 * Build the Windows-only npm packages from pinned official niubash portable
 * archives. Nothing is downloaded on macOS/Linux user installs: this runs only
 * in PiWeb's release workflow (or explicitly by a maintainer).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
	MANAGED_NIUBASH_ASSETS,
	NIUBASH_LICENSES,
	NIUBASH_REPOSITORY,
	NIUBASH_TAG,
	listFiles,
	niubashAssetUrl,
	sha256,
	sha256File,
	validateManagedNiubashPackage,
} from "./managed-niubash-assets.mjs";
import { isMainModule } from "./entrypoint.mjs";

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function download(url, expectedSha256) {
	let lastError;
	for (let attempt = 1; attempt <= 3; attempt += 1) {
		try {
			const response = await fetch(url, {
				headers: { "user-agent": "PiWeb managed-niubash packager" },
				signal: AbortSignal.timeout(120_000),
			});
			if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
			const data = Buffer.from(await response.arrayBuffer());
			const actual = sha256(data);
			if (actual !== expectedSha256) throw new Error(`SHA-256 mismatch: expected ${expectedSha256}, got ${actual}`);
			return data;
		} catch (error) {
			lastError = error;
			if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
		}
	}
	throw new Error(`failed to download ${url}: ${lastError instanceof Error ? lastError.message : lastError}`);
}

function extractZip(archive, destination) {
	fs.mkdirSync(destination, { recursive: true });
	let result;
	if (process.platform === "win32") {
		result = spawnSync("powershell.exe", [
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			"Expand-Archive -LiteralPath $env:PIWEB_NIUBASH_ARCHIVE -DestinationPath $env:PIWEB_NIUBASH_DESTINATION -Force",
		], {
			encoding: "utf8",
			env: { ...process.env, PIWEB_NIUBASH_ARCHIVE: archive, PIWEB_NIUBASH_DESTINATION: destination },
		});
	} else {
		result = spawnSync("unzip", ["-q", "-o", archive, "-d", destination], { encoding: "utf8" });
		if (result.error?.code === "ENOENT") {
			result = spawnSync("python3", ["-m", "zipfile", "-e", archive, destination], { encoding: "utf8" });
		}
	}
	if (result.error) throw new Error(`cannot extract ${path.basename(archive)}: ${result.error.message}`);
	if (result.status !== 0) throw new Error(`cannot extract ${path.basename(archive)}: ${result.stderr || result.stdout}`);
}

async function replaceDirectory(source, destination) {
	fs.rmSync(destination, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
	for (let attempt = 1; ; attempt += 1) {
		try {
			fs.renameSync(source, destination);
			return;
		} catch (error) {
			// Windows：刚写入几百个文件时，Defender/索引器会短暂持有句柄，目录 rename 报 EPERM。
			// 先退避重试，仍不行就退化成复制（读通常是被允许的）。
			if (!["EPERM", "EBUSY", "EACCES"].includes(error?.code)) throw error;
			if (attempt >= 5) {
				fs.cpSync(source, destination, { recursive: true });
				fs.rmSync(source, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
				return;
			}
			await new Promise((resolve) => setTimeout(resolve, attempt * 250));
		}
	}
}

function extractedPortableRoot(destination) {
	const entries = fs.readdirSync(destination, { withFileTypes: true }).filter((entry) => entry.name !== "__MACOSX");
	if (entries.length !== 1 || !entries[0].isDirectory()) throw new Error("niubash archive must contain exactly one top-level directory");
	return path.join(destination, entries[0].name);
}

async function prepareLicenses(root, packageRoot) {
	const destination = path.join(packageRoot, "licenses");
	const staging = path.join(packageRoot, `.licenses-${process.pid}`);
	fs.rmSync(staging, { recursive: true, force: true });
	fs.mkdirSync(staging, { recursive: true });
	try {
		for (const license of NIUBASH_LICENSES) {
			const source = path.join(root, "third-party", "managed-niubash", "licenses", license.filename);
			if (sha256File(source) !== license.sha256) throw new Error(`license source failed integrity check: ${license.filename}`);
			fs.copyFileSync(source, path.join(staging, license.filename));
		}
		await replaceDirectory(staging, destination);
	} finally {
		fs.rmSync(staging, { recursive: true, force: true });
	}
}

async function prepareAsset(root, asset, log) {
	const packageRoot = path.join(root, "platform-packages", asset.directory);
	if (!fs.existsSync(path.join(packageRoot, "package.json"))) throw new Error(`missing platform package skeleton: ${packageRoot}`);
	const temporary = fs.mkdtempSync(path.join(os.tmpdir(), `piweb-niubash-${asset.arch}-`));
	const archive = path.join(temporary, asset.asset);
	const extracted = path.join(temporary, "extracted");
	const staging = path.join(packageRoot, `.runtime-${process.pid}`);
	try {
		log(`[piweb] Downloading ${asset.asset} ...`);
		fs.writeFileSync(archive, await download(niubashAssetUrl(asset), asset.sha256));
		extractZip(archive, extracted);
		const source = extractedPortableRoot(extracted);
		for (const required of ["niu.exe", "winuxcmd", "bundles"]) {
			if (!fs.existsSync(path.join(source, required))) throw new Error(`${asset.asset} is missing ${required}`);
		}

		fs.rmSync(staging, { recursive: true, force: true });
		fs.cpSync(source, staging, { recursive: true });
		await replaceDirectory(staging, path.join(packageRoot, "runtime"));
		const runtime = path.join(packageRoot, "runtime");

		const files = {};
		for (const relative of listFiles(runtime)) files[relative] = sha256File(path.join(runtime, ...relative.split("/")));
		fs.writeFileSync(path.join(packageRoot, "runtime-manifest.json"), `${JSON.stringify({
			schema: 1,
			source: { repository: NIUBASH_REPOSITORY, tag: NIUBASH_TAG, asset: asset.asset, sha256: asset.sha256 },
			files,
		}, null, 2)}\n`);
		await prepareLicenses(root, packageRoot);
		const checked = validateManagedNiubashPackage(packageRoot, asset, { allowExtraRuntimeFiles: false });
		log(`[piweb] Prepared ${asset.packageName}: ${checked.files} runtime files.`);
		return checked;
	} finally {
		fs.rmSync(staging, { recursive: true, force: true });
		fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
	}
}

function selectAssets(args) {
	if (args.length === 0) return Object.values(MANAGED_NIUBASH_ASSETS);
	if (args.length === 1 && args[0] === "--current") {
		if (process.platform !== "win32" || !(process.arch in MANAGED_NIUBASH_ASSETS)) {
			throw new Error(`--current requires Windows x64/ARM64 (got ${process.platform}/${process.arch})`);
		}
		return [MANAGED_NIUBASH_ASSETS[process.arch]];
	}
	if (args.length === 1 && args[0].startsWith("--arch=")) {
		const arch = args[0].slice("--arch=".length);
		const asset = MANAGED_NIUBASH_ASSETS[arch];
		if (!asset) throw new Error(`unsupported niubash architecture: ${arch}`);
		return [asset];
	}
	throw new Error("Usage: node scripts/prepare-niubash-packages.mjs [--current|--arch=x64|--arch=arm64]");
}

export async function prepareManagedNiubashPackages(root = DEFAULT_ROOT, { args = [], log = console.log } = {}) {
	const results = [];
	for (const asset of selectAssets(args)) results.push(await prepareAsset(root, asset, log));
	return results;
}

if (isMainModule(import.meta.url)) {
	try {
		await prepareManagedNiubashPackages(DEFAULT_ROOT, { args: process.argv.slice(2) });
	} catch (error) {
		console.error(`[piweb] ${error instanceof Error ? error.message : error}`);
		process.exitCode = 1;
	}
}
