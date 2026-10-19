#!/usr/bin/env node
/**
 * Release gate for the prebuilt artifact: pack the package exactly as
 * `npm publish` would, unpack it somewhere else, and validate the copy with the
 * same check the launcher runs before starting. The CLI also installs the tarball
 * into an empty global prefix and imports the real Pi SDK.
 *
 * `files` is a whitelist, so enumerating Next internals by hand ships a package
 * that installs cleanly and then dies on first start with a missing manifest
 * (required-server-files.json, routes-manifest.json, ...). Unpacking the real
 * tarball is the only way to catch that before users do.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readProductionBuild } from "./build-output.mjs";
import { isMainModule } from "./entrypoint.mjs";
import { PI_PACKAGE, verifyPiRuntimePins } from "./runtime/pi-packages.mjs";

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(command, args, options = {}) {
	const result = spawnSync(command, args, { encoding: "utf8", stdio: "pipe", ...options });
	if (result.error) throw new Error(`cannot run ${command}: ${result.error.message}`);
	if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed:\n${result.stderr || result.stdout}`);
	return result.stdout;
}

/**
 * npm is a .cmd shim on Windows, which needs a shell — and shell + args is deprecated
 * as well as unsafe with paths containing spaces. Whenever npm invoked us (npm test,
 * npm run verify:package, CI) it hands us its own CLI entry, so run that with node.
 */
function runNpm(args, options) {
	const cli = [process.env.npm_execpath, path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")]
		.find((file) => file?.endsWith(".js") && fs.existsSync(file));
	if (cli) return run(process.execPath, [cli, ...args], options);
	return run("npm", args, { ...options, shell: process.platform === "win32" });
}

/** Install the tarball into an empty global prefix; checkout node_modules cannot hide drift. */
function verifyInstalledRuntime(tarball, tmp, manifest, log) {
	const prefix = path.join(tmp, "installed");
	const env = { ...process.env, PI_CODING_AGENT_DIR: path.join(tmp, "agent"), PI_OFFLINE: "1" };
	runNpm(["install", "--global", "--prefix", prefix, "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", tarball], {
		cwd: tmp, env, timeout: 600_000,
	});
	const modules = process.platform === "win32" ? path.join(prefix, "node_modules") : path.join(prefix, "lib", "node_modules");
	const installed = path.join(modules, ...manifest.name.split("/"));
	run(process.execPath, [path.join(installed, "scripts", "runtime", "check-installed.mjs")], {
		cwd: installed, timeout: 180_000,
		env: { ...env, NODE_ENV: "production", PI_WEB_ROOT: installed, PIWEB_REMOTE_LAN: "0", PI_WEB_AUTH: "0", PI_WEB_UPDATE_CHECK: "0", NEXT_TELEMETRY_DISABLED: "1" },
	});
	log("[piweb] Clean global installation: Pi " + verifyPiRuntimePins(manifest) + " SDK, production startup, home page and first-paint APIs passed");
}

/**
 * @param {string} root
 * @returns {{filename: string, files: string[], buildId: string, bytes: number}}
 */
export function verifyPackedPackage(root, { log = console.log, runtime = false } = {}) {
	const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
	if (manifest.dependencies?.[PI_PACKAGE]) verifyPiRuntimePins(manifest);
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-verify-"));
	try {
		const packed = JSON.parse(runNpm(["pack", "--json", "--pack-destination", tmp], { cwd: root }));
		// npm 12 keys results by package name; earlier versions return an array
		// (or a single entry). Keep all three forms compatible.
		const entry = Array.isArray(packed) ? packed[0] : packed?.filename ? packed : packed?.[manifest.name];
		if (typeof entry?.filename !== "string" || !entry.filename.endsWith(".tgz") || /[\\/]/.test(entry.filename)) {
			throw new Error("npm pack produced no tarball");
		}
		const files = (entry.files ?? []).map((file) => String(file.path).replaceAll("\\", "/").replace(/^package\//, ""));
		const cached = files.find((file) => file.startsWith(".next/cache/"));
		if (cached) throw new Error(`the packaged .next must not include the build cache (${cached}); remove .next/cache before packing`);
		if (!files.includes("package.json")) throw new Error("the tarball has no package.json");
		const unpacked = path.join(tmp, "unpacked");
		fs.mkdirSync(unpacked, { recursive: true });
		// Run from tmp with relative names: GNU tar (Git for Windows) reads "C:\..." as a
		// remote host and tries to connect to it, so no absolute path may reach the args.
		run("tar", ["-xzf", entry.filename, "-C", "unpacked"], { cwd: tmp });
		// Same validation the launcher applies to an installed package.
		const build = readProductionBuild(path.join(unpacked, "package"), ".next");
		if (runtime) verifyInstalledRuntime(path.join(tmp, entry.filename), tmp, manifest, log);
		const bytes = fs.statSync(path.join(tmp, entry.filename)).size;
		log(`[piweb] ${entry.filename}: ${files.length} files, ${(bytes / 1024 / 1024).toFixed(1)} MB, build ${build.buildId}`);
		return { filename: entry.filename, files, buildId: build.buildId, bytes };
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
	}
}

if (isMainModule(import.meta.url)) {
	try {
		verifyPackedPackage(DEFAULT_ROOT, { runtime: true });
	} catch (error) {
		console.error(`[piweb] ${error instanceof Error ? error.message : error}`);
		process.exitCode = 1;
	}
}
