/** Pi's packages are released together and must resolve to the same runtime version. */
export const PI_PACKAGE = "@earendil-works/pi-coding-agent";
export const PI_AI_PACKAGE = "@earendil-works/pi-ai";
export const PI_RUNTIME_PACKAGES = Object.freeze([
	PI_PACKAGE, PI_AI_PACKAGE,
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-codemode",
	"@earendil-works/pi-mcp",
	"@earendil-works/pi-telemetry",
	"@earendil-works/pi-tui",
]);

/** @param {string} version */
export function piRuntimeSpecs(version) {
	if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
		throw new Error("Pi runtime requires an exact version; received " + JSON.stringify(version));
	}
	return PI_RUNTIME_PACKAGES.map((name) => name + "@" + version);
}

/** The repository lockfile is not used when a user installs a published package. */
export function verifyPiRuntimePins(manifest) {
	const version = manifest.dependencies?.[PI_PACKAGE];
	piRuntimeSpecs(version);
	for (const name of PI_RUNTIME_PACKAGES) {
		if (manifest.dependencies?.[name] !== version) {
			throw new Error("Pi runtime dependency " + name + " must be pinned to " + version
				+ "; a published package can otherwise mix incompatible Pi versions");
		}
	}
	return version;
}

/**
 * Resolve the release once, then install every Pi package at that exact version.
 * Separate @latest lookups can mix releases while upstream is publishing.
 * @param {{root: string, env: Record<string, string | undefined>, run: typeof import("../process-runner.mjs").runCommand, signal?: AbortSignal}} context
 * @param {{omitDev?: boolean, assertIdle?: () => Promise<void>}} [options]
 */
export async function installPiRuntime({ root, env, run, signal }, { omitDev = false, assertIdle = async () => {} } = {}) {
	await assertIdle();
	const version = (await run("npm", ["view", PI_PACKAGE + "@latest", "version"], {
		cwd: root, env, timeoutMs: 30_000, signal,
	})).trim();
	const specs = piRuntimeSpecs(version);
	await assertIdle();
	await run("npm", ["install", "--save-exact", ...specs, ...(omitDev ? ["--omit=dev"] : []), "--no-audit", "--no-fund"], {
		cwd: root, env, timeoutMs: 600_000, signal,
	});
	return version;
}
