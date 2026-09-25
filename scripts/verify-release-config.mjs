import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { assertInstallation, resolveBuildOutput, RELEASES_DIR } from "./build-output.mjs";
import { isMainModule } from "./entrypoint.mjs";

/** Run in a fresh process after install/pull so cached Next config cannot be reused. */
export async function verifyReleaseConfig(root = process.cwd(), env = process.env) {
	const installation = assertInstallation(root);
	const buildDir = resolveBuildOutput(installation, env.PIWEB_BUILD_DIR);
	if (!buildDir.startsWith(`${RELEASES_DIR}/`)) throw new Error("release requires an isolated build output");
	const requireFromInstall = createRequire(path.join(installation, "package.json"));
	const module = await import(pathToFileURL(requireFromInstall.resolve("next/dist/server/config.js")).href);
	const loadConfig = typeof module.default === "function" ? module.default : module.default.default;
	const { PHASE_PRODUCTION_BUILD } = requireFromInstall("next/constants");
	const config = await loadConfig(PHASE_PRODUCTION_BUILD, installation, { silent: true });
	if (config.distDir !== buildDir || config.typescript?.tsconfigPath !== `${RELEASES_DIR}/tsconfig.json` || config.typescript?.ignoreBuildErrors) {
		throw new Error("Next config does not honor the isolated release directory/typecheck; refusing to build over the serving output");
	}
}

if (isMainModule(import.meta.url)) {
	await verifyReleaseConfig();
}
