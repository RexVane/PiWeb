#!/usr/bin/env node
/** Default PiWeb entrypoint. All startup logic is import-safe for regression tests. */
import { isMainModule, runLauncher } from "../scripts/launcher.mjs";

if (isMainModule(import.meta.url)) {
	try {
		process.exitCode = await runLauncher();
	} catch (error) {
		console.error(`[piweb] ${error instanceof Error ? error.message : error}`);
		process.exitCode = 1;
	}
}
