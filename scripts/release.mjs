import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { assertInstallation, assertLocalPath, readProductionBuild, resolveBuildOutput, RELEASES_DIR, RELEASE_MANIFEST } from "./build-output.mjs";
import { runCommand } from "./process-runner.mjs";
import { isMainModule } from "./entrypoint.mjs";

/**
 * Root of the PiWeb installation this module belongs to.
 *
 * A Next server bundle substitutes `import.meta.url` with the URL of the SOURCE file on
 * the machine that ran the build, so a published package carries the CI path. That both
 * throws (`fileURLToPath` rejects a POSIX path inside a file URL on Windows —
 * ERR_INVALID_FILE_URL_PATH) and points at a directory that does not exist on the user's
 * machine. The launcher's PI_WEB_ROOT and the working directory are trustworthy; the
 * module URL is consulted only while it still points at a real checkout.
 * @param {{env?: Record<string, string | undefined>, cwd?: string, moduleUrl?: string}} [context]
 * @returns {string}
 */
export function resolveReleaseRoot({ env = process.env, cwd = process.cwd(), moduleUrl } = {}) {
	if (env.PI_WEB_ROOT) return path.resolve(env.PI_WEB_ROOT);
	if (typeof moduleUrl === "string") {
		try {
			const fromModule = path.resolve(path.dirname(fileURLToPath(moduleUrl)), "..");
			if (existsSync(path.join(fromModule, "scripts", "release.mjs"))) return fromModule;
		} catch {
			/* a URL for another platform's layout: fall through to the working directory */
		}
	}
	return path.resolve(cwd);
}

const ROOT = resolveReleaseRoot({ moduleUrl: import.meta.url });
const LOCK_PATH = `${RELEASES_DIR}/update.lock`;
const CONFIG_PATH = `${RELEASES_DIR}/tsconfig.json`;

/** Rename within one directory: a launcher sees the complete old or new state. */
async function atomicJson(root, relative, value) {
	const target = assertLocalPath(root, relative);
	const temporary = assertLocalPath(root, `${relative}.${randomUUID()}.tmp`);
	const handle = await fs.open(temporary, "wx", 0o600);
	try {
		try {
			await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
			await handle.sync();
		} finally { await handle.close(); }
		await fs.rename(temporary, target);
	} finally { await fs.rm(temporary, { force: true }); }
}

async function acquireLock(root) {
	const lockPath = assertLocalPath(root, LOCK_PATH);
	let lock;
	try { lock = await fs.open(lockPath, "wx", 0o600); }
	catch (error) {
		if (error.code === "EEXIST") throw new Error(`an update/build is already running (${lockPath}); after an interrupted build, confirm its process tree has stopped before removing this lock and retrying npm run build:release`);
		throw error;
	}
	try { await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })); }
	catch (error) { await lock.close(); await fs.unlink(lockPath); throw error; }
	return async () => { await lock.close(); await fs.unlink(lockPath); };
}

async function writeReleaseTypeConfig(root, buildDir) {
	const id = buildDir.slice(`${RELEASES_DIR}/`.length);
	await atomicJson(root, CONFIG_PATH, {
		extends: "../tsconfig.json",
		compilerOptions: { tsBuildInfoFile: `./${id}.tsbuildinfo` },
		include: [
			"../next-env.d.ts", "../*.ts", "../*.mts", "../src/**/*.ts", "../src/**/*.tsx",
			"../tests/**/*.ts", "../tests/**/*.tsx", `./${id}/types/**/*.ts`, `./${id}/dev/types/**/*.ts`,
		],
		exclude: ["../node_modules", "../pi", "../dsh", "../bin"],
	});
}

export const PI_PACKAGE = "@earendil-works/pi-coding-agent";
const PI_AI_PACKAGE = "@earendil-works/pi-ai";

/**
 * Shared by the UI and update:pi; called only after the building state is durable.
 * @param {{root: string, env: Record<string, string | undefined>, run: typeof runCommand, signal?: AbortSignal}} context
 * @param {() => Promise<void>} [assertIdle]
 * @returns {Promise<string>}
 */
export async function installPiUpdate({ root, env, run, signal }, assertIdle = async () => {}) {
	await assertIdle();
	await run("npm", ["install", "--save-exact", `${PI_PACKAGE}@latest`, `${PI_AI_PACKAGE}@latest`, "--no-audit", "--no-fund"], {
		cwd: root, env, timeoutMs: 600_000, signal,
	});
	await run("npm", ["run", "sync:provider-icons"], { cwd: root, env, timeoutMs: 60_000, signal });
	const manifest = JSON.parse(await fs.readFile(path.join(root, "node_modules", PI_PACKAGE, "package.json"), "utf8"));
	if (typeof manifest.version !== "string" || !manifest.version) throw new Error("Pi engine package version is missing");
	return manifest.version;
}

/**
 * Prepare one production output without touching the serving .next/release.
 * Source/dependency preparation is deliberately a caller callback: this command
 * alone never fetches Git or installs packages, and works in a no-Git source copy.
 * @param {{root?: string, env?: Record<string, string | undefined>, run?: typeof runCommand,
 * beforePrepare?: () => Promise<void>, prepare?: (context: {root: string, buildDir: string, env: Record<string, string | undefined>, run: typeof runCommand, signal?: AbortSignal}) => Promise<void>,
 * signal?: AbortSignal}} options
 */
export async function prepareRelease({ root = ROOT, env = process.env, run = runCommand, beforePrepare, prepare, signal } = {}) {
	const installation = assertInstallation(root);
	const releases = assertLocalPath(installation, RELEASES_DIR);
	await fs.mkdir(releases, { recursive: true });
	assertLocalPath(installation, RELEASES_DIR);
	const releaseLock = await acquireLock(installation);
	let started = false;
	let state;
	try {
		await beforePrepare?.();
		signal?.throwIfAborted();
		const buildDir = resolveBuildOutput(installation, `${RELEASES_DIR}/${Date.now().toString(36)}-${randomUUID()}`);
		// Never reuse a failed or previous directory, even if it has a BUILD_ID.
		await fs.mkdir(assertLocalPath(installation, buildDir));
		state = { schema: 1, state: "building", buildDir, startedAt: new Date().toISOString() };
		await atomicJson(installation, RELEASE_MANIFEST, state);
		started = true;
		const childEnv = {
			...env, PI_WEB_ROOT: installation, PIWEB_BUILD_DIR: buildDir,
			PYTHONUTF8: env.PYTHONUTF8 ?? "1", PYTHONIOENCODING: env.PYTHONIOENCODING ?? "utf-8",
		};
		// Do not pass the live web password to Git/npm/package build scripts.
		delete childEnv.PI_WEB_PASSWORD;
		delete childEnv.PI_WEB_DEV;
		delete childEnv.NODE_ENV;
		const context = { root: installation, buildDir, env: childEnv, run, signal };
		await prepare?.(context);
		signal?.throwIfAborted();
		assertInstallation(installation);
		await writeReleaseTypeConfig(installation, buildDir);
		await run(process.execPath, [path.join(installation, "scripts", "verify-release-config.mjs")], {
			cwd: installation, env: childEnv, timeoutMs: 60_000, signal,
		});
		await run("npm", ["run", "check"], { cwd: installation, env: childEnv, timeoutMs: 600_000, signal });
		signal?.throwIfAborted();
		const build = readProductionBuild(installation, buildDir);
		const version = JSON.parse(await fs.readFile(path.join(installation, "package.json"), "utf8")).version;
		if (typeof version !== "string" || !version) throw new Error("PiWeb package version is missing");
		await atomicJson(installation, RELEASE_MANIFEST, { ...state, ...build, state: "ready", version, finishedAt: new Date().toISOString() });
		return { ...build, version, needsRestart: true };
	} catch (error) {
		if (started) {
			try { await atomicJson(installation, RELEASE_MANIFEST, { ...state, state: "failed", finishedAt: new Date().toISOString() }); }
			catch { /* The previously persisted building state still blocks stale fallback. */ }
		}
		throw error;
	} finally { await releaseLock(); }
}

if (isMainModule(import.meta.url)) {
	const controller = new AbortController();
	const cancel = () => controller.abort();
	process.once("SIGINT", cancel);
	process.once("SIGTERM", cancel);
	try {
		const updatePi = process.argv.length === 3 && process.argv[2] === "--update-pi";
		if (process.argv.length > 2 && !updatePi) throw new Error("Usage: node scripts/release.mjs [--update-pi]");
		console.log("[piweb] Checking and building an isolated release; the existing server is not restarted.");
		if (updatePi) console.log("[piweb] Pi dependency update: use a maintenance window with no active sessions; node_modules is shared.");
		const release = await prepareRelease({
			signal: controller.signal,
			prepare: updatePi ? async (context) => { await installPiUpdate(context); } : undefined,
		});
		console.log(`[piweb] Release ready: ${release.buildDir} (${release.buildId}). Restart PiWeb manually when idle to use it.`);
	} catch (error) {
		console.error(`[piweb] Release failed: ${error instanceof Error ? error.message : error}`);
		process.exitCode = 1;
	} finally {
		process.off("SIGINT", cancel);
		process.off("SIGTERM", cancel);
	}
}
