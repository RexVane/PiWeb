#!/usr/bin/env node
/**
 * Run the pinned ESLint toolchain for PiWeb.
 *
 * The root package builds with TypeScript 7 (native), which typescript-eslint does not
 * support yet, so lint dependencies live in this directory with their own lockfile and
 * TypeScript 6 parser. This wrapper keeps `npm run lint` a single command:
 *
 *   - `node scripts/testing/lint/run.mjs`                 install (when needed), then lint src/scripts/bin/tests
 *   - `node scripts/testing/lint/run.mjs src/proxy.ts`    lint explicit paths
 *   - `PIWEB_LINT_SKIP_INSTALL=1 ...`                     never touch the network; fail if deps are missing
 *
 * CI should run `npm ci --prefix scripts/testing/lint` once and then set
 * PIWEB_LINT_SKIP_INSTALL=1 so the lint step itself cannot install anything.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { npmCommand } from "../../npm-command.mjs";

const lintDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(lintDir, "../../..");
const lockFile = path.join(lintDir, "package-lock.json");
const stampFile = path.join(lintDir, "node_modules", ".piweb-lint-toolchain");
const eslintBin = path.join(lintDir, "node_modules", "eslint", "bin", "eslint.js");
const defaultPaths = ["src", "scripts", "bin", "tests"];
const explicitPaths = process.argv.slice(2);

function installed() {
	if (!fs.existsSync(eslintBin)) return false;
	let stamp = "";
	try {
		stamp = fs.readFileSync(stampFile, "utf8");
	} catch {
		// CI and manual installs use `npm ci --prefix scripts/testing/lint`, which cannot write
		// this stamp. If the eslint binary exists and no stale stamp is present, trust that
		// install and record the lock hash so later offline runs stay fast.
		stamp = "";
	}
	const hash = lockHash();
	if (stamp === hash) return true;
	if (stamp) return false;
	try {
		fs.writeFileSync(stampFile, hash);
	} catch {
		// A read-only install still lints; the stamp is only a cache marker.
	}
	return true;
}

function lockHash() {
	return createHash("sha256").update(fs.readFileSync(lockFile)).digest("hex");
}

function run(command, args, options) {
	const result = spawnSync(command, args, { cwd: root, stdio: "inherit", windowsHide: true, ...options });
	if (result.error) throw new Error(`cannot run ${command}: ${result.error.message}`);
	return result.status ?? 1;
}

function install() {
	const started = Date.now();
	let invocation;
	try {
		invocation = npmCommand(["ci", "--prefix", lintDir, "--ignore-scripts", "--no-audit", "--no-fund"], process.env);
	} catch (error) {
		throw new Error(`${error instanceof Error ? error.message : error}\nInstall the lint toolchain manually with: npm ci --prefix scripts/testing/lint`);
	}
	console.log(`[piweb] Installing the pinned lint toolchain (${path.relative(root, lintDir)})...`);
	const status = run(invocation.command, invocation.args);
	if (status !== 0) throw new Error(`lint toolchain install failed with exit code ${status}`);
	fs.writeFileSync(stampFile, lockHash());
	console.log(`[piweb] Lint toolchain installed in ${((Date.now() - started) / 1000).toFixed(1)}s.`);
}

try {
	if (!installed()) {
		if (process.env.PIWEB_LINT_SKIP_INSTALL) {
			throw new Error(`the pinned lint toolchain is missing or stale in ${path.relative(root, lintDir)} while PIWEB_LINT_SKIP_INSTALL is set; run npm ci --prefix scripts/testing/lint first`);
		}
		install();
	}
	if (!fs.existsSync(eslintBin)) throw new Error(`the pinned lint toolchain has no eslint binary; run npm ci --prefix ${path.relative(root, lintDir)}`);
	process.exitCode = run(process.execPath, [eslintBin, ...(explicitPaths.length ? explicitPaths : defaultPaths)]);
} catch (error) {
	console.error(`[piweb] ${error instanceof Error ? error.message : error}`);
	process.exitCode = 1;
}
