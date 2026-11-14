import type { DefaultPackageManager } from "@earendil-works/pi-coding-agent";
import path from "node:path";
import { beginNpmSettingsWrite, npmTransactionPath, recoverNpmPrefix } from "./npm-install-transaction";

export class PackageSourceValidationError extends Error {}

/** npm: is a registry package reference; local directories and git keep their own syntax. */
export function validatePackageSource(source: string): void {
	if (typeof source !== "string" || !source.trim() || source.length > 4096 || /[\x00-\x1f\x7f]/.test(source)) {
		throw new PackageSourceValidationError("Invalid package source.");
	}
	if (!source.startsWith("npm:")) return;
	const spec = source.slice(4).trim();
	const match = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@([a-z0-9*^~<>=][a-z0-9.*+^~<>=| -]*))?$/i.exec(spec);
	if (!match || spec.length > 512) {
		throw new PackageSourceValidationError("npm: must name a registry package, optionally with a version or tag; use a local path or git source separately.");
	}
}

const secured = new WeakSet<DefaultPackageManager>();

/** Scope the installed SDK's process adapter to this manager, never process.env. */
export function securePackageManager(manager: DefaultPackageManager): DefaultPackageManager {
	if (secured.has(manager)) return manager;
	const internal = manager as unknown as {
		cwd: string;
		agentDir: string;
		parseSource(source: string): unknown;
		runNpmCommand(args: string[], options?: { cwd?: string }): Promise<void>;
		getNpmInstallRoot(scope: string, temporary: boolean): string;
		getManagedNpmInstallPath(source: unknown, scope: string): string;
		addSourceToSettings(source: string, options?: { local?: boolean }): boolean;
		removeSourceFromSettings(source: string, options?: { local?: boolean }): boolean;
		settingsManager: { reload(): Promise<void> };
	};
	if ([internal.parseSource, internal.runNpmCommand, internal.getNpmInstallRoot, internal.getManagedNpmInstallPath, internal.addSourceToSettings, internal.removeSourceFromSettings, manager.resolve, manager.resolveExtensionSources, internal.settingsManager?.reload].some((method) => typeof method !== "function")) {
		throw new Error("This pi SDK package manager is unsupported; PiWeb cannot safely manage plugin installations.");
	}
	const parseSource = internal.parseSource.bind(manager);
	const runNpmCommand = internal.runNpmCommand.bind(manager);
	const rootFor = internal.getNpmInstallRoot.bind(manager);
	const installedFor = internal.getManagedNpmInstallPath.bind(manager);
	const scopes = [
		{ root: path.join(internal.agentDir, "npm") },
		{ root: path.join(internal.cwd, ".pi", "npm"), projectRoot: internal.cwd },
	];
	const recoverBeforeResolution = async () => {
		let recovered = false;
		for (const scope of scopes) recovered = recoverNpmPrefix(scope.root, scope.projectRoot, scopes) || recovered;
		if (recovered) await internal.settingsManager.reload();
	};
	// A crashed remove can leave packages:[]; no installed-path lookup would run.
	// Restore disk and the SDK cache before it snapshots either package list.
	const resolve = manager.resolve.bind(manager);
	manager.resolve = async (...args) => { await recoverBeforeResolution(); return resolve(...args); };
	const resolveExtensions = manager.resolveExtensionSources.bind(manager);
	manager.resolveExtensionSources = async (...args) => { await recoverBeforeResolution(); return resolveExtensions(...args); };
	const preparedRoot = (scope: string, temporary: boolean) => {
		const root = rootFor(scope, temporary);
		if (!temporary && scope !== "temporary") recoverNpmPrefix(root, scope === "project" ? internal.cwd : undefined, scopes);
		return root;
	};
	internal.getNpmInstallRoot = (scope, temporary) => npmTransactionPath(preparedRoot(scope, temporary));
	internal.getManagedNpmInstallPath = (source, scope) => {
		preparedRoot(scope, scope === "temporary");
		return npmTransactionPath(installedFor(source, scope));
	};
	for (const name of ["addSourceToSettings", "removeSourceFromSettings"] as const) {
		const original = internal[name].bind(manager);
		internal[name] = (source, options) => {
			if (source.startsWith("npm:")) beginNpmSettingsWrite(rootFor(options?.local ? "project" : "user", false));
			return original(source, options);
		};
	}
	internal.parseSource = (source) => { validatePackageSource(source); return parseSource(source); };
	internal.runNpmCommand = (args, options) => {
		const mutating = /^(?:install|uninstall|update|add|remove)$/.test(args[0] ?? "");
		return runNpmCommand(mutating ? [...args, "--ignore-scripts"] : args, options);
	};
	secured.add(manager);
	return manager;
}
