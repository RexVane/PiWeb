#!/usr/bin/env node
import path from "node:path";
import { createRequire } from "node:module";
import { runCommand } from "./process-runner.mjs";
import { writeBuildInventory } from "./build-output.mjs";
import { trackLockChild } from "./file-lock.mjs";
const root = process.cwd();
const require = createRequire(path.join(root, "package.json"));
const next = path.join(path.dirname(require.resolve("next/package.json")), "dist", "bin", "next");
// Next collects its build warnings/errors on stdout+stderr; runCommand buffers them and only
// bubbles the tail on failure. PIWEB_BUILD_VERBOSE=1 (or =true) prints the collected output
// so a CI failure can be diagnosed without a rebuild; the default output is unchanged.
const verbose = /^(1|true|yes)$/i.test(process.env.PIWEB_BUILD_VERBOSE ?? "");
try {
	const onStart = process.env.PIWEB_BUILD_LOCK_FILE && process.env.PIWEB_BUILD_LOCK_TOKEN
		? (pid) => trackLockChild(process.env.PIWEB_BUILD_LOCK_FILE, process.env.PIWEB_BUILD_LOCK_TOKEN, pid) : undefined;
	if (onStart) onStart(process.pid);
	const output = await runCommand(process.execPath, ["--max-old-space-size=8192", next, "build", "--webpack"], { cwd: root, onStart });
	if (verbose && output) process.stdout.write(output);
	const inventory = writeBuildInventory(root, process.env.PIWEB_BUILD_DIR);
	console.log(`[piweb] Build sealed: ${inventory.files.length} runtime files (${inventory.buildId}).`);
} catch (error) {
	console.error(error instanceof Error ? error.message : error);
	if (verbose) {
		if (error instanceof Error && typeof error.output === "string" && error.output) process.stdout.write(error.output);
		if (error instanceof Error && error.stack) console.error(error.stack);
	}
	process.exitCode = 1;
}
