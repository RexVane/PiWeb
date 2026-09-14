/**
 * Fixed-command update preparation followed by a checked, isolated Next release.
 * Source/node_modules changes are not snapshots: run only in a maintenance window.
 * No serving process is stopped, and a build is selected only on a manual restart.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { installPiUpdate, PI_PACKAGE, prepareRelease } from "../../scripts/release.mjs";
import { assertInstallation } from "../../scripts/build-output.mjs";
import { runCommand } from "../../scripts/process-runner.mjs";
import { isNewer } from "./semver";
import { getRuntimeVersions } from "./version";
import { APP_ROOT } from "./app-root";

export type UpdateTarget = "piweb" | "pi";

export interface UpdateCheck {
	current: string;
	latest: string;
	canUpdate: boolean;
	/** Only piweb: commits behind the branch which the update command pulls. */
	behind?: number;
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
}

function assertTarget(target: UpdateTarget): void {
	if (target !== "piweb" && target !== "pi") throw new Error("unknown target");
}

async function readPackageVersion(filePath: string): Promise<string> {
	const raw = JSON.parse(await fs.readFile(filePath, "utf8")) as { version?: unknown };
	if (typeof raw.version !== "string" || !raw.version) throw new Error(`no version field in ${filePath}`);
	return raw.version;
}

/** Injectable process runner/root: tests never contact registries or update this checkout. */
export function createUpdateService({ root = APP_ROOT, run = runCommand, versions = getRuntimeVersions, env = process.env }: UpdateServiceOptions = {}) {
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
			return { current: piEngine, latest, canUpdate: isNewer(latest, piEngine) };
		}
		await command("git", ["fetch", "origin", "main", "--tags"], 30_000);
		const behind = Number((await command("git", ["rev-list", "--count", "HEAD..origin/main"], 15_000)).trim());
		if (!Number.isSafeInteger(behind) || behind < 0) throw new Error("invalid upstream commit count");
		const remotePkg = JSON.parse(await command("git", ["show", "origin/main:package.json"], 15_000)) as { name?: string; version?: string };
		if (remotePkg.name !== "pi-web" || typeof remotePkg.version !== "string" || !remotePkg.version) throw new Error("upstream is not a PiWeb package");
		// Do not advertise a tag version that `git pull origin main` will never install.
		return { current: piWeb, latest: remotePkg.version, behind, canUpdate: isNewer(remotePkg.version, piWeb) || behind > 0 };
	}

	async function runUpdate(target: UpdateTarget, { assertIdle = async () => {} }: { assertIdle?: () => Promise<void> } = {}): Promise<UpdateResult> {
		assertTarget(target);
		if (updateRunning) throw new UpdateBusyError("an update is already running");
		updateRunning = true;
		try {
			const installation = await checkedRoot();
			let version = "";
			const release = await prepareRelease({
				root: installation, env, run,
				beforePrepare: async () => {
					await assertIdle();
					if (target === "piweb") {
						const command = (args: string[]) => run("git", args, { cwd: installation, env: commandEnv, timeoutMs: 15_000 });
						const top = (await command(["rev-parse", "--show-toplevel"])).trim();
						if (await fs.realpath(top) !== installation) throw new Error("refusing to update: PiWeb is not the Git installation root");
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
