import fs from "node:fs";
import path from "node:path";

export const RELEASES_DIR = ".next-releases";
export const RELEASE_MANIFEST = `${RELEASES_DIR}/active.json`;
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
	if (manifest?.name !== "pi-web") throw new Error(`refusing to update outside the PiWeb installation: ${realRoot}`);
	return realRoot;
}

function readLocalFile(root, relative, maxBytes = 1024 * 1024) {
	const file = assertLocalPath(root, relative);
	const stat = fs.statSync(file);
	if (!stat.isFile() || stat.size > maxBytes) throw new Error(`invalid deployment file: ${relative}`);
	return fs.readFileSync(file, "utf8");
}

/** Verify a finished Next production build, not just a leftover BUILD_ID. */
export function readProductionBuild(root, value) {
	const buildDir = resolveBuildOutput(root, value);
	const buildId = readLocalFile(root, `${buildDir}/BUILD_ID`, 1024).trim();
	if (!buildId || /\s/.test(buildId)) throw new Error(`invalid BUILD_ID in ${buildDir}`);
	const required = JSON.parse(readLocalFile(root, `${buildDir}/required-server-files.json`));
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
		if (!fs.statSync(target).isFile()) throw new Error(`missing required build file: ${file}`);
	}
	return { buildDir, buildId };
}

/**
 * A failed/interrupted release deliberately blocks fallback to old .next output.
 * An explicit env override must not bypass that guard or select another release.
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
		try { manifest = JSON.parse(raw); } catch { throw new Error("invalid release manifest; run npm run build:release"); }
		if (manifest?.schema !== 1 || manifest.state !== "ready") {
			throw new Error("release is incomplete or failed; finish npm run build:release before restarting (no stale-build fallback)");
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
