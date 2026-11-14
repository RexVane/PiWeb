import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export const RELEASES_DIR = ".next-releases";
export const RELEASE_MANIFEST = `${RELEASES_DIR}/active.json`;
export const RELEASE_READY_MANIFEST = `${RELEASES_DIR}/last-ready.json`;
export const BUILD_INVENTORY = "piweb-build-inventory.json";
/** Bound accumulation without deleting a user's retained releases.
 * @param {string} root
 * @param {Record<string, string | undefined>} env
 */
export function assertReleaseCapacity(root, env = process.env) {
	const limit = Number(env.PIWEB_MAX_RETAINED_RELEASES ?? 10);
	if (!Number.isInteger(limit) || limit < 2 || limit > 100) throw new Error("PIWEB_MAX_RETAINED_RELEASES must be between 2 and 100");
	let entries;
	try { entries = fs.readdirSync(assertLocalPath(root, RELEASES_DIR), { withFileTypes: true }); }
	catch (error) { if (error.code === "ENOENT") return; throw error; }
	const protectedDirs = new Set();
	try {
		const active = JSON.parse(readLocalFile(root, RELEASE_MANIFEST));
		for (const build of [active, active.previous]) if (build?.state === "ready" && typeof build?.buildDir === "string") protectedDirs.add(build.buildDir);
	} catch { /* A missing first release has no protected directory. */ }
	const count = entries.filter((entry) => {
		if (!entry.isDirectory() || protectedDirs.has(`${RELEASES_DIR}/${entry.name}`)) return false;
		try { const inventory = JSON.parse(readLocalFile(root, `${RELEASES_DIR}/${entry.name}/${BUILD_INVENTORY}`, 16 * 1024 * 1024)); return inventory.schema === 1 && Array.isArray(inventory.files); }
		catch { return false; }
	}).length;
	if (count >= limit) throw new Error(`${count} retained release directories reached the limit ${limit}; archive old inactive releases manually before building. Existing releases were preserved.`);
	const failedLimit = Number(env.PIWEB_MAX_FAILED_RELEASES ?? 3);
	if (!Number.isInteger(failedLimit) || failedLimit < 1 || failedLimit > 100) throw new Error("PIWEB_MAX_FAILED_RELEASES must be between 1 and 100");
	const failed = entries.filter((entry) => {
		if (!entry.isDirectory()) return false;
		const buildDir = `${RELEASES_DIR}/${entry.name}`;
		try { const owner = JSON.parse(readLocalFile(root, `${buildDir}.owner.json`, 16384)); return owner.schema === 1 && owner.buildDir === buildDir && ["building", "failed"].includes(owner.state); }
		catch { return false; }
	});
	if (failed.length >= failedLimit) throw new Error(`${failed.length} owned unfinished releases reached the limit ${failedLimit}: ${failed.map((entry) => entry.name).join(", ")}. Move these inactive directories and matching .owner.json files to backups/files with a dated name, append backups/INDEX.md, then retry. No existing files were removed.`);
}
const RELEASE_PATH = /^\.next-releases\/[A-Za-z0-9_-]{1,100}$/;

/**
 * Next distDir must remain inside the installation. Reject links even when they
 * currently point inside it, so build/start cannot be redirected through them.
 * @param {string} root
 * @param {string | undefined} value
 * @returns {string} A canonical project-relative output directory.
 */
export function resolveBuildOutput(root, value) {
	const relative = value === undefined ? ".next" : value;
	if (typeof relative !== "string" || (relative !== ".next" && !RELEASE_PATH.test(relative))) {
		throw new Error("PIWEB_BUILD_DIR must be .next or .next-releases/<safe-id>");
	}
	assertLocalPath(root, relative);
	return relative;
}

/** Validate every existing component, including a file at the end of the path. */
export function assertLocalPath(root, relative) {
	if (typeof relative !== "string" || !relative || relative.includes("\\") || relative.includes(":")) {
		throw new Error("invalid project-relative path");
	}
	const parts = relative.split("/");
	if (parts.some((part) => !part || part === "." || part === "..")) throw new Error("invalid project-relative path");
	const realRoot = fs.realpathSync(root);
	let current = realRoot;
	for (const part of parts) {
		current = path.join(current, part);
		let stat;
		try {
			stat = fs.lstatSync(current);
		} catch (error) {
			if (error.code === "ENOENT") break;
			throw error;
		}
		if (stat.isSymbolicLink()) throw new Error(`refusing linked deployment path: ${relative}`);
		const resolved = fs.realpathSync(current);
		const inside = path.relative(realRoot, resolved);
		if (inside === ".." || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) {
			throw new Error(`deployment path escapes installation: ${relative}`);
		}
	}
	return path.join(realRoot, ...parts);
}

/** Only real PiWeb installations may be changed by the release/update helpers. */
export function assertInstallation(root) {
	const realRoot = fs.realpathSync(root);
	const manifestPath = assertLocalPath(realRoot, "package.json");
	const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
	// Accept the historical names so installations made before the npm rename keep working.
	const validNames = ["piweb", "pi-web", "@rexvane/piweb"];
	if (!validNames.includes(manifest?.name)) throw new Error(`refusing to update outside the PiWeb installation: ${realRoot}`);
	return realRoot;
}

function readLocalFile(root, relative, maxBytes = 1024 * 1024) {
	const file = assertLocalPath(root, relative);
	const stat = fs.statSync(file);
	if (!stat.isFile() || stat.size > maxBytes) throw new Error(`invalid deployment file: ${relative}`);
	return fs.readFileSync(file, "utf8");
}

function runtimeFiles(root, buildDir) {
	const files = [];
	function walk(relative) {
		for (const entry of fs.readdirSync(assertLocalPath(root, relative), { withFileTypes: true })) {
			const file = `${relative}/${entry.name}`;
			if (relative === buildDir && ["cache", "diagnostics", "trace", "trace-build", BUILD_INVENTORY].includes(entry.name)) continue;
			if (entry.isSymbolicLink()) throw new Error(`refusing linked build file: ${file}`);
			if (entry.isDirectory()) walk(file);
			else if (entry.isFile()) files.push({ file: file.slice(buildDir.length + 1), bytes: fs.statSync(assertLocalPath(root, file)).size,
				sha256: createHash("sha256").update(fs.readFileSync(assertLocalPath(root, file))).digest("hex") });
		}
	}
	walk(buildDir);
	return files.sort((a, b) => a.file.localeCompare(b.file));
}

/** Seal the finished build once; validation never re-creates a missing-file inventory. */
export function writeBuildInventory(root, value) {
	const buildDir = resolveBuildOutput(root, value);
	readProductionBuild(root, buildDir, { inventory: false });
	const requiredPath = assertLocalPath(root, `${buildDir}/required-server-files.json`);
	const required = JSON.parse(fs.readFileSync(requiredPath, "utf8"));
	fs.writeFileSync(requiredPath, JSON.stringify({ ...required, piwebInventory: 1 }));
	const inventory = { schema: 1, buildId: readLocalFile(root, `${buildDir}/BUILD_ID`, 1024).trim(), files: runtimeFiles(root, buildDir) };
	const target = assertLocalPath(root, `${buildDir}/${BUILD_INVENTORY}`);
	fs.writeFileSync(target, `${JSON.stringify(inventory)}\n`, { mode: 0o600 });
	return inventory;
}

function verifyInventory(root, buildDir, buildId) {
	let raw;
	try { raw = readLocalFile(root, `${buildDir}/${BUILD_INVENTORY}`, 16 * 1024 * 1024); }
	catch (error) { if (error.code === "ENOENT") return false; throw error; }
	const inventory = JSON.parse(raw);
	if (inventory.schema !== 1 || inventory.buildId !== buildId || !Array.isArray(inventory.files) || !inventory.files.length) throw new Error(`invalid build inventory in ${buildDir}`);
	for (const file of inventory.files) {
		if (typeof file.file !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.bytes)) throw new Error(`invalid build inventory in ${buildDir}`);
		const target = assertLocalPath(root, `${buildDir}/${file.file}`);
		try {
			if (!fs.statSync(target).isFile() || fs.statSync(target).size !== file.bytes || createHash("sha256").update(fs.readFileSync(target)).digest("hex") !== file.sha256) {
				throw new Error(`changed production build file: ${file.file}`);
			}
		} catch (error) { if (error.code === "ENOENT") throw new Error(incompleteBuildMessage(buildDir, file.file)); throw error; }
	}
	return true;
}

/**
 * A truncated .next (package built without the runtime manifests, or an interrupted
 * build) leaves BUILD_ID behind, so the raw ENOENT names a file the user cannot act on.
 */
export function incompleteBuildMessage(buildDir, missing = "required-server-files.json") {
	return `incomplete production build in ${buildDir}: ${missing} is missing. `
		+ "Reinstall with `npm install -g @rexvane/piweb@latest`, or rebuild this installation with `npm rebuild -g @rexvane/piweb`.";
}

function readRequiredServerFiles(root, buildDir) {
	try {
		return readLocalFile(root, `${buildDir}/required-server-files.json`);
	} catch (error) {
		if (error.code === "ENOENT") throw new Error(incompleteBuildMessage(buildDir));
		throw error;
	}
}

/** Verify a finished Next production build, not just a leftover BUILD_ID. */
export function readProductionBuild(root, value, { inventory = true } = {}) {
	const buildDir = resolveBuildOutput(root, value);
	let buildId;
	try { buildId = readLocalFile(root, `${buildDir}/BUILD_ID`, 1024).trim(); }
	catch (error) { if (error.code === "ENOENT") throw Object.assign(new Error(incompleteBuildMessage(buildDir, "BUILD_ID")), { code: "ENOENT" }); throw error; }
	if (!buildId || /\s/.test(buildId)) throw new Error(`invalid BUILD_ID in ${buildDir}`);
	const required = JSON.parse(readRequiredServerFiles(root, buildDir));
	if (required?.version !== 1 || required.config?.distDir?.replaceAll("\\", "/") !== buildDir) {
		throw new Error(`build output does not match ${buildDir}`);
	}
	if (!Array.isArray(required.files) || !required.files.length) throw new Error(`incomplete build in ${buildDir}`);
	const files = new Set(required.files.map((file) => typeof file === "string" ? file.replaceAll("\\", "/") : ""));
	for (const mandatory of ["BUILD_ID", "routes-manifest.json", "build-manifest.json", "prerender-manifest.json", "server/app-paths-manifest.json"]) {
		files.add(`${buildDir}/${mandatory}`);
	}
	for (const file of files) {
		if (!file.startsWith(`${buildDir}/`)) throw new Error(`invalid required build file: ${file}`);
		const target = assertLocalPath(root, file);
		try { if (!fs.statSync(target).isFile()) throw new Error(`missing required build file: ${file}`); }
		catch (error) { if (error.code === "ENOENT") throw new Error(incompleteBuildMessage(buildDir, file)); throw error; }
	}
	// Legacy builds have no inventory. Still validate every route/chunk explicitly
	// named in Next's manifests, which required-server-files itself does not include.
	const appPaths = JSON.parse(readLocalFile(root, `${buildDir}/server/app-paths-manifest.json`));
	for (const route of Object.values(appPaths)) {
		if (typeof route !== "string") throw new Error(`invalid app paths in ${buildDir}`);
		try { if (!fs.statSync(assertLocalPath(root, `${buildDir}/server/${route}`)).isFile()) throw new Error(`invalid route ${route}`); }
		catch (error) { if (error.code === "ENOENT") throw new Error(incompleteBuildMessage(buildDir, route)); throw error; }
	}
	const buildManifest = JSON.parse(readLocalFile(root, `${buildDir}/build-manifest.json`));
	const chunks = [...(buildManifest.rootMainFiles ?? []), ...(buildManifest.polyfillFiles ?? []), ...Object.values(buildManifest.pages ?? {}).flat()];
	for (const chunk of chunks) {
		if (typeof chunk !== "string") throw new Error(`invalid chunk in ${buildDir}`);
		try { if (!fs.statSync(assertLocalPath(root, `${buildDir}/${chunk}`)).isFile()) throw new Error(`invalid chunk ${chunk}`); }
		catch (error) { if (error.code === "ENOENT") throw new Error(incompleteBuildMessage(buildDir, chunk)); throw error; }
	}
	if (inventory && !verifyInventory(root, buildDir, buildId) && required.piwebInventory === 1) throw new Error(incompleteBuildMessage(buildDir, BUILD_INVENTORY));
	return { buildDir, buildId };
}

/**
 * A failed/interrupted release can use its last complete ready output.
 * An explicit override must match that validated output and cannot select another release.
 * @param {string} root
 * @param {string} [requested]
 * @returns {{buildDir: string, buildId: string} | null}
 */
export function selectProductionBuild(root, requested) {
	const explicit = requested === undefined ? undefined : resolveBuildOutput(root, requested);
	let raw;
	try {
		raw = readLocalFile(root, RELEASE_MANIFEST, 16 * 1024);
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	if (raw !== undefined) {
		let manifest;
		try { manifest = JSON.parse(raw); } catch {
			// Recover only a separately persisted ready selection, never a random
			// BUILD_ID from an unfinished/failed release directory.
			try { manifest = JSON.parse(readLocalFile(root, RELEASE_READY_MANIFEST, 16 * 1024)); }
			catch { throw new Error("invalid release manifest and no saved ready selection; run npm run build:release"); }
			if (manifest?.state !== "ready") throw new Error("invalid saved release selection; run npm run build:release");
		}
		if (manifest?.schema !== 1) throw new Error("invalid release manifest; run npm run build:release");
		if (manifest.state !== "ready") {
			if (manifest.state !== "building" && manifest.state !== "failed") throw new Error("invalid release manifest; run npm run build:release");
			if (manifest.previous?.state === "ready") manifest = manifest.previous;
			else {
				try { return readProductionBuild(root, explicit ?? ".next"); }
				catch { throw new Error("release is incomplete or failed and no complete prior build is available; run npm run build:release"); }
			}
		}
		if (typeof manifest.buildDir !== "string" || !RELEASE_PATH.test(manifest.buildDir) || typeof manifest.buildId !== "string") {
			throw new Error("invalid release manifest; run npm run build:release");
		}
		if (explicit !== undefined && explicit !== manifest.buildDir) {
			throw new Error("PIWEB_BUILD_DIR conflicts with the active release; unset it before starting PiWeb");
		}
		const build = readProductionBuild(root, manifest.buildDir);
		if (build.buildId !== manifest.buildId) throw new Error("release BUILD_ID changed; run npm run build:release");
		return build;
	}
	// Release outputs are usable only after the complete check/build transaction.
	if (explicit && explicit !== ".next") throw new Error("release output has not been promoted; run npm run build:release");
	try {
		return readProductionBuild(root, ".next");
	} catch (error) {
		// Only a genuinely absent build allows the local development fallback.
		if (error.code === "ENOENT" && !fs.existsSync(path.join(root, ".next", "BUILD_ID"))) return null;
		throw error;
	}
}
