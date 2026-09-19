#!/usr/bin/env node
/** Native smoke test. Run on both windows-latest (x64) and windows-11-arm. */
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import { MANAGED_NIUBASH_ASSETS, validateManagedNiubashPackage } from "./managed-niubash-assets.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (process.platform !== "win32" || !(process.arch in MANAGED_NIUBASH_ASSETS)) {
	throw new Error(`managed niubash smoke test requires Windows x64/ARM64 (got ${process.platform}/${process.arch})`);
}
const asset = MANAGED_NIUBASH_ASSETS[process.arch];
const packageRoot = path.join(root, "platform-packages", asset.directory);
validateManagedNiubashPackage(packageRoot, asset, { allowExtraRuntimeFiles: false });
const require = createRequire(path.join(root, "package.json"));
const runtime = require(path.join(packageRoot, "index.cjs"));
assert.equal(runtime.packageName, asset.packageName);
assert.equal(runtime.arch, process.arch);

const version = spawnSync(runtime.shellPath, ["--version"], { encoding: "utf8", windowsHide: true });
assert.equal(version.status, 0, version.stderr);
assert.match(version.stdout, /Niubash 1\.1\.4/);
assert.match(version.stdout, /rubash\s+git 8b81c7501646/);
assert.match(version.stdout, /winuxcmd WinuxCmd 1\.0\.8/);

const operations = createLocalBashOperations({ shellPath: runtime.shellPath });
async function execute(command, options = {}) {
	const chunks = [];
	const result = await operations.exec(command, process.cwd(), {
		onData: (data) => chunks.push(data),
		...options,
	});
	return { exitCode: result.exitCode, output: Buffer.concat(chunks).toString("utf8") };
}

const empty = await execute("");
assert.equal(empty.exitCode, 0);
assert.equal(empty.output, "");

const pwd = await execute("pwd");
assert.equal(pwd.exitCode, 0);
assert.equal(path.resolve(pwd.output.trim().replaceAll("/", path.sep)).toLowerCase(), path.resolve(process.cwd()).toLowerCase());

const quoted = await execute(`node -e "console.log(JSON.stringify(process.argv.slice(1)))" 'a b' '' 'c"d' 'e\\f'`);
assert.equal(quoted.exitCode, 0, quoted.output);
assert.deepEqual(JSON.parse(quoted.output.trim()), ["a b", "", "c\"d", "e\\f"]);

const shellQuotedCwd = process.cwd().replaceAll("'", `'"'"'`);
const windowsPath = await execute(`cd '${shellQuotedCwd}' && pwd`);
assert.equal(windowsPath.exitCode, 0, windowsPath.output);
assert.equal(path.resolve(windowsPath.output.trim().replaceAll("/", path.sep)).toLowerCase(), path.resolve(process.cwd()).toLowerCase());

await assert.rejects(() => execute("sleep 5", { timeout: 0.1 }), /timeout/);
const controller = new AbortController();
const aborted = execute("sleep 5", { signal: controller.signal });
setTimeout(() => controller.abort(), 100);
await assert.rejects(() => aborted, /aborted/);

console.log(`[piweb] Managed niubash ${process.arch} smoke test passed (${version.stdout.split(/\r?\n/, 1)[0]}).`);
