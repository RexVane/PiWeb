/**
 * Fixed-command update preparation followed by a checked, isolated Next release.
 * Source/node_modules changes are not snapshots: run only in a maintenance window.
 * No serving process is stopped, and a build is selected only on a manual restart.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { installPiUpdate, PI_PACKAGE, prepareRelease } from "../../scripts/release.mjs";
import { assertInstallation, readProductionBuild } from "../../scripts/build-output.mjs";
import { runCommand } from "../../scripts/process-runner.mjs";
import { isNewer } from "./semver";
import { samePath } from "./path-security";
import { getRuntimeVersions } from "./version";
import { APP_ROOT } from "./app-root";

export type UpdateTarget = "piweb" | "pi";

export interface UpdateCheck {
	current: string;
	latest: string;
	canUpdate: boolean;
	/** Only piweb: commits behind the branch which the update command pulls. */
	behind?: number;
	/**
	 * Whether PiWeb can apply the update itself. False on an npm installation running on
	 * Windows: the live server's own directory is the package being replaced, so npm gets
	 * EBUSY — the UI offers the command instead of a button and the user restarts piweb.
	 */
	selfUpdate: boolean;
	/** The exact command to run when `selfUpdate` is false. */
	command?: string;
}

export interface UpdateResult {
	version: string;
	needsRestart: boolean;
	buildDir: string;
	buildId: string;
}

export class UpdateBusyError extends Error {}

type CommandRunner = typeof runCommand;

interface UpdateServiceOptions {
	root?: string;
	run?: CommandRunner;
	versions?: typeof getRuntimeVersions;
	env?: Record<string, string | undefined>;
	/** Injectable so both the in-place and the instruct-the-user branches stay testable. */
	platform?: NodeJS.Platform;
}

function assertTarget(target: UpdateTarget): void {
	if (target !== "piweb" && target !== "pi") throw new Error("unknown target");
}

/** The published package users install and update through npm. */
const PIWEB_PACKAGE = "@rexvane/piweb";

/**
 * A package installed by npm lives at `<prefix>/node_modules/@rexvane/piweb`, and only
 * that layout can be updated by `npm install -g`. A Git checkout keeps the branch-based
 * flow (`git pull` + local release), which npm would not touch.
 */
function isNpmInstall(root: string): boolean {
	return path.resolve(root).split(/[\\/]/).includes("node_modules");
}

/**
 * Windows refuses to rename the installation directory while the server runs inside it
 * (`next start` is spawned with the installation as its working directory), so an npm
 * installation can only replace itself on POSIX. Verified: npm reports EBUSY while
 * serving and succeeds with the same command once the process is stopped.
 * @param {NodeJS.Platform} [platform]
 */
export function canSelfUpdateNpmInstall(platform: NodeJS.Platform = process.platform): boolean {
	return platform !== "win32";
}

/** The one command every install path documents, with the build it should fetch. */
export const PIWEB_INSTALL_COMMAND = `npm install -g ${PIWEB_PACKAGE}@latest`;

async function readPackageVersion(filePath: string): Promise<string> {
	const raw = JSON.parse(await fs.readFile(filePath, "utf8")) as { version?: unknown };
	if (typeof raw.version !== "string" || !raw.version) throw new Error(`no version field in ${filePath}`);
	return raw.version;
}

/** Injectable process runner/root: tests never contact registries or update this checkout. */
export function createUpdateService({ root = APP_ROOT, run = runCommand, versions = getRuntimeVersions, env = process.env, platform = process.platform }: UpdateServiceOptions = {}) {
	let updateRunning = false;
	const commandEnv = { ...env };
	delete commandEnv.PI_WEB_PASSWORD;

	async function checkedRoot(): Promise<string> {
		return assertInstallation(root);
	}

	async function checkForUpdate(target: UpdateTarget): Promise<UpdateCheck> {
		assertTarget(target);
		if (updateRunning) throw new UpdateBusyError("an update is already running");
		const installation = await checkedRoot();
		const command = (cmd: string, args: string[], timeoutMs: number) => run(cmd, args, { cwd: installation, env: commandEnv, timeoutMs });
		const { piWeb, piEngine } = await versions();
		if (target === "pi") {
			const latest = (await command("npm", ["view", PI_PACKAGE, "version"], 30_000)).trim().split(/\r?\n/)[0];
			return { current: piEngine, latest, canUpdate: isNewer(latest, piEngine), selfUpdate: true };
		}
		if (isNpmInstall(installation)) {
			// npm 安装对着 registry（用户自己的 registry 配置）比版本，没有「落后几个提交」的概念。
			const latest = (await command("npm", ["view", PIWEB_PACKAGE, "version"], 30_000)).trim().split(/\r?\n/)[0];
			if (!latest) throw new Error(`cannot read the published version of ${PIWEB_PACKAGE}`);
			const selfUpdate = canSelfUpdateNpmInstall(platform);
			return { current: piWeb, latest, canUpdate: isNewer(latest, piWeb), selfUpdate, ...(selfUpdate ? {} : { command: PIWEB_INSTALL_COMMAND }) };
		}
		await command("git", ["fetch", "origin", "main", "--tags"], 30_000);
		const behind = Number((await command("git", ["rev-list", "--count", "HEAD..origin/main"], 15_000)).trim());
		if (!Number.isSafeInteger(behind) || behind < 0) throw new Error("invalid upstream commit count");
		const remotePkg = JSON.parse(await command("git", ["show", "origin/main:package.json"], 15_000)) as { name?: string; version?: string };
		if (!["piweb", "pi-web", "@rexvane/piweb"].includes(String(remotePkg.name)) || typeof remotePkg.version !== "string" || !remotePkg.version) throw new Error("upstream is not a PiWeb package");
		// Do not advertise a tag version that `git pull origin main` will never install.
		return { current: piWeb, latest: remotePkg.version, behind, canUpdate: isNewer(remotePkg.version, piWeb) || behind > 0, selfUpdate: true };
	}

	/**
	 * Update an npm-installed PiWeb in place with the command its users were told to run.
	 * The published package ships a ready build, so there is nothing to compile; the
	 * running process keeps its old code until the user restarts.
	 */
	async function installFromRegistry(installation: string, assertIdle: () => Promise<void>): Promise<UpdateResult> {
		if (!canSelfUpdateNpmInstall(platform)) {
			// The UI shows this command instead of a button; keeping the check here means a
			// stale page cannot start an install that is guaranteed to fail.
			throw new Error(`Windows cannot replace a running PiWeb. Stop piweb, then run: ${PIWEB_INSTALL_COMMAND}`);
		}
		await assertIdle();
		const command = (args: string[], timeoutMs: number) => run("npm", args, { cwd: installation, env: commandEnv, timeoutMs });
		const manifestPath = path.join(installation, "package.json");
		const before = await readPackageVersion(manifestPath);
		await command(["install", "-g", `${PIWEB_PACKAGE}@latest`, "--no-audit", "--no-fund"], 600_000);
		await assertIdle();
		assertInstallation(installation);
		const version = await readPackageVersion(manifestPath);
		if (version === before) {
			// Either already current, or this PiWeb is not the copy the global prefix owns
			// (e.g. a project dependency): say so instead of reporting a no-op as success.
			const latest = (await command(["view", `${PIWEB_PACKAGE}@latest`, "version"], 30_000)).trim().split(/\r?\n/)[0];
			if (isNewer(latest, before)) {
				throw new Error(`npm updated a different copy of ${PIWEB_PACKAGE}; this installation is not the global package. Update it the way it was installed.`);
			}
		}
		// Fails loudly if the installed artifact is incomplete, instead of after a restart.
		return { ...readProductionBuild(installation, ".next"), version, needsRestart: true };
	}

	async function runUpdate(target: UpdateTarget, { assertIdle = async () => {} }: { assertIdle?: () => Promise<void> } = {}): Promise<UpdateResult> {
		assertTarget(target);
		if (updateRunning) throw new UpdateBusyError("an update is already running");
		updateRunning = true;
		try {
			const installation = await checkedRoot();
			// npm 安装：装发布好的成品即可——不需要 Git，也不需要本地构建（成品包自带 .next）。
			if (target === "piweb" && isNpmInstall(installation)) return await installFromRegistry(installation, assertIdle);
			let version = "";
			const release = await prepareRelease({
				root: installation, env, run,
				beforePrepare: async () => {
					await assertIdle();
					if (target === "piweb") {
						const command = (args: string[]) => run("git", args, { cwd: installation, env: commandEnv, timeoutMs: 15_000 });
						const top = (await command(["rev-parse", "--show-toplevel"])).trim();
						// Git may report a differently cased or 8.3-shortened path; compare canonically.
						const realTop = await fs.realpath(top).catch(() => path.resolve(top));
						if (!samePath(realTop, installation)) throw new Error("refusing to update: PiWeb is not the Git installation root");
						if ((await command(["status", "--porcelain", "--untracked-files=no"])).trim()) {
							throw new Error("PiWeb has local tracked changes; preserve them before updating (no files were reset)");
						}
					}
					await assertIdle();
				},
				prepare: async (context) => {
					const { env: releaseEnv, signal } = context;
					const command = (cmd: string, args: string[], timeoutMs: number) => run(cmd, args, { cwd: installation, env: releaseEnv, timeoutMs, signal });
					if (target === "pi") {
						version = await installPiUpdate(context, assertIdle);
					} else {
						await assertIdle();
						await command("git", ["pull", "--ff-only", "origin", "main"], 120_000);
						assertInstallation(installation);
						await assertIdle();
						await command("npm", ["install", "--no-audit", "--no-fund"], 600_000);
						version = await readPackageVersion(path.join(installation, "package.json"));
					}
				},
			});
			return { ...release, version, needsRestart: true };
		} finally { updateRunning = false; }
	}
	return { checkForUpdate, runUpdate };
}

const service = createUpdateService();
export const checkForUpdate = service.checkForUpdate;
export const runUpdate = service.runUpdate;
