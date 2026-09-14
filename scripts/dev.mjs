import { isMainModule, runLauncher } from "./launcher.mjs";

/**
 * npm run dev forwards only known launcher options; no raw Next flags can override the host.
 * @param {import('./launcher.mjs').LauncherOptions} [options]
 */
export function runDev({ args = process.argv.slice(2), ...options } = {}) {
	return runLauncher({ ...options, args: ["--dev", "--no-open", ...args] });
}

if (isMainModule(import.meta.url)) {
	try {
		process.exitCode = await runDev();
	} catch (error) {
		console.error(`[piweb] ${error instanceof Error ? error.message : error}`);
		process.exitCode = 1;
	}
}
