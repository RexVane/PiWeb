#!/usr/bin/env node
import path from "node:path";
import { createRequire } from "node:module";
import { runCommand } from "./process-runner.mjs";
import { writeBuildInventory } from "./build-output.mjs";
import { trackLockChild } from "./file-lock.mjs";
const root = process.cwd();
const require = createRequire(path.join(root, "package.json"));
const next = path.join(path.dirname(require.resolve("next/package.json")), "dist", "bin", "next");
try {
	const onStart = process.env.PIWEB_BUILD_LOCK_FILE && process.env.PIWEB_BUILD_LOCK_TOKEN
		? (pid) => trackLockChild(process.env.PIWEB_BUILD_LOCK_FILE, process.env.PIWEB_BUILD_LOCK_TOKEN, pid) : undefined;
	if (onStart) onStart(process.pid);
	await runCommand(process.execPath, ["--max-old-space-size=8192", next, "build", "--webpack"], { cwd: root, onStart });
	const inventory = writeBuildInventory(root, process.env.PIWEB_BUILD_DIR);
	console.log(`[piweb] Build sealed: ${inventory.files.length} runtime files (${inventory.buildId}).`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
