#!/usr/bin/env node
/**
 * One-time production build for production-only installs (e.g. `npm install -g piweb`).
 *
 * Such an install has no dev dependencies, so neither the launcher's development
 * fallback nor a per-start build works. The build is prepared once — either from
 * the npm postinstall hook or from the first `piweb` run — and reused afterwards.
 *
 * Repository checkouts always have dev dependencies and keep `npm run dev`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { acquireFileLock } from "./file-lock.mjs";
import { lockChildEnvironment } from "./lock-child-env.mjs";
import { readProductionBuild, selectProductionBuild, writeBuildInventory, assertLocalPath, assertReleaseCapacity, RELEASES_DIR, RELEASE_MANIFEST, RELEASE_READY_MANIFEST } from "./build-output.mjs";
import { writeJsonAtomically } from "./atomic-json.mjs";

/**
 * A leftover BUILD_ID is not a usable build: a package that shipped .next without
 * its runtime manifests starts and then dies on a missing manifest. Only a build
 * that passes the same validation the launcher applies counts as prepared, so a
 * truncated install falls through to the one-time build instead of crashing.
 */
export function hasProductionBuild(root) {
	try {
		return selectProductionBuild(root) !== null;
	} catch {
		return false;
	}
}

/**
 * Repository checkouts install the test dev dependencies; a published package
 * installed with npm (globally or with --omit=dev) never has them.
 */
export function isProductionOnlyInstall(root) {
	if (process.env.npm_config_global === "true") return true;
	const markers = ["vitest", "jsdom"];
	return !markers.some((name) => {
		try {
			return fs.existsSync(path.join(root, "node_modules", name, "package.json"))
				|| fs.existsSync(path.join(path.dirname(root), name, "package.json"));
		} catch {
			return false;
		}
	});
}

/** npm hoists dependencies for global installs, so `next` may live one level up. */
export function resolveNextBin(root) {
	const candidates = [
		path.join(root, "node_modules", "next", "package.json"),
		path.join(path.dirname(root), "next", "package.json"),
	];
	for (const manifest of candidates) {
		try {
			const info = JSON.parse(fs.readFileSync(manifest, "utf8"));
			const bin = typeof info.bin === "string" ? info.bin : info.bin?.next;
			const resolved = path.resolve(path.dirname(manifest), bin ?? "dist/bin/next");
			if (fs.existsSync(resolved)) return resolved;
		} catch { /* try the next candidate */ }
	}
	try {
		const require = createRequire(path.join(root, "package.json"));
		return path.join(path.dirname(require.resolve("next/package.json")), "bin", "next");
	} catch {
		return null;
	}
}

/**
 * Next's webpack/SWC rules exclude everything under `node_modules`, and an
 * installed package lives exactly there, so its TypeScript sources would be
 * neither compiled nor mapped through the `@/*` path alias. Build in a staging
 * directory outside `node_modules` (same drive, so the dependency links resolve)
 * and copy the finished output back into the package.
 *
 * The staging directory must NOT sit inside any `node_modules`: for a global
 * install like ~/.local/lib/node_modules/@rexvane/piweb, the grandparent IS
 * node_modules, and Next would exclude the staged sources exactly the same way.
 * It must also stay on the package's own volume: a node_modules link that crosses
 * volumes makes webpack resolve dependencies as "./D:/..." and the build fails.
 */
function stagingParent(root) {
	// Split on BOTH separators: a win32 Node can see POSIX paths (and vice versa)
	// when the package is installed through a compatibility layer or the test
	// suite simulates foreign layouts.
	const segments = path.dirname(root).split(/[\\/]/).filter(Boolean);
	// Drop trailing path components while the path still contains a node_modules segment.
	while (segments.length > 1 && segments.includes("node_modules")) {
		segments.pop();
	}
	// Same-volume candidates first; only a broken layout falls back to the temp dir.
	const outside = segments.length ? pathFromSegments(segments) : undefined;
	const candidates = [outside, outside && path.parse(outside).root, os.tmpdir()];
	for (const candidate of candidates) {
		if (candidate && isWritableDirectory(candidate)) return candidate;
	}
	return outside ?? os.tmpdir();
}

/**
 * Rebuild a path from already-split segments. Only a Windows drive segment is a
 * prefix; on POSIX the first segment is a real directory and must survive.
 */
function pathFromSegments(segments) {
	if (/^[A-Za-z]:$/.test(segments[0])) return path.join(`${segments[0]}${path.sep}`, ...segments.slice(1));
	return path.join(path.sep, ...segments);
}

function isWritableDirectory(candidate) {
	// Never create anything here: the popped prefix of an installed package always
	// exists, and a simulated/foreign layout must not litter the filesystem. The
	// caller falls back to the temp dir when mkdtemp cannot use this parent.
	try {
		if (!fs.statSync(candidate).isDirectory()) return false;
		fs.accessSync(candidate, fs.constants.W_OK);
		return true;
	} catch {
		return false;
	}
}

/** Staging directory must live outside EVERY node_modules on the way up (Next excludes those paths). */
export function assertStagingOutsideNodeModules(root) {
	const parent = stagingParent(root);
	if (parent.split(/[\\/]/).includes("node_modules")) {
		throw new Error(`staging parent is inside node_modules: ${parent}`);
	}
	return parent;
}

function linkOrCopyDependencies(root, staging, log) {
	const target = path.join(root, "node_modules");
	const linkPath = path.join(staging, "node_modules");
	// Windows: junction 不需要符号链接权限；跨卷时 junction 也会失败（试回退）。
	// POSIX（macOS/Linux）: 目录符号链接即可，"junction" 类型会被 libuv 拒绝。
	const type = process.platform === "win32" ? "junction" : "dir";
	try {
		fs.symlinkSync(target, linkPath, type);
		return;
	} catch (error) {
		// EEXIST：链接已存在（重入/上次构建残留）。指向正确位置就复用，否则删了重建。
		if (error.code === "EEXIST") {
			try {
				const existing = fs.readlinkSync(linkPath);
				if (path.resolve(path.dirname(linkPath), existing) === path.resolve(target)) return;
				fs.rmSync(linkPath, { recursive: true, force: true });
				fs.symlinkSync(target, linkPath, type);
				return;
			} catch {
				/* fall through to the copy */
			}
		}
	}
	// 兜底：符号链接不可用（如无权限）时整份复制依赖。慢但保证构建可解析。
	log("[piweb] Symlink unavailable; copying dependencies into the staging build (slower)...");
	fs.cpSync(target, linkPath, { recursive: true, verbatimSymlinks: true });
}

function buildInStaging(root, nextBin, env, log, warn, sourceRoot = root) {
	let staging;
	let outputDir;
	let promoted = false;
	try {
		staging = fs.mkdtempSync(path.join(stagingParent(root), ".piweb-build-"));
	} catch {
		staging = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-build-"));
	}
	try {
		for (const entry of ["src", "public", "assets", "scripts", "bin"]) {
			const from = path.join(entry === "src" ? sourceRoot : root, entry);
			if (fs.existsSync(from)) fs.cpSync(from, path.join(staging, entry), { recursive: true });
		}
		for (const file of ["package.json", "tsconfig.json", "next.config.ts", "postcss.config.mjs"]) {
			const from = path.join(root, file);
			if (fs.existsSync(from)) fs.copyFileSync(from, path.join(staging, file));
		}
		linkOrCopyDependencies(root, staging, log);
		const buildDir = `${RELEASES_DIR}/install-${Date.now().toString(36)}-${randomUUID()}`;
		fs.mkdirSync(path.join(staging, RELEASES_DIR));
		fs.writeFileSync(path.join(staging, RELEASES_DIR, "tsconfig.json"), JSON.stringify({ extends: "../tsconfig.json", include: ["../src/**/*.ts", "../src/**/*.tsx", "../next-env.d.ts", `./${buildDir.split("/")[1]}/types/**/*.ts`], exclude: ["../node_modules"] }));
		const buildEnv = { ...env, PIWEB_BUILD_DIR: buildDir, PI_WEB_ROOT: staging };
		log(`[piweb] Building in ${staging} ...`);
		const result = spawnSync(process.execPath, [path.join(staging, "scripts", "build.mjs")], { cwd: staging, stdio: "inherit", env: lockChildEnvironment(buildEnv), windowsHide: true });
		const produced = path.join(staging, buildDir, "BUILD_ID");
		if (result.status !== 0 || !fs.existsSync(produced)) return false;
		writeBuildInventory(staging, buildDir);
		const target = assertLocalPath(root, buildDir);
		// Copy to a fresh immutable release; failure cannot remove the serving output.
		fs.mkdirSync(assertLocalPath(root, RELEASES_DIR), { recursive: true });
		outputDir = buildDir;
		fs.writeFileSync(assertLocalPath(root, `${buildDir}.owner.json`), JSON.stringify({ schema: 1, buildDir, state: "building" }), { flag: "wx", mode: 0o600 });
		fs.cpSync(path.join(staging, buildDir), target, { recursive: true, errorOnExist: true, force: false });
		const build = readProductionBuild(root, buildDir);
		const active = assertLocalPath(root, RELEASE_MANIFEST);
		let previous;
		try { const prior = selectProductionBuild(root); if (prior?.buildDir.startsWith(`${RELEASES_DIR}/`)) previous = { schema: 1, state: "ready", ...prior }; } catch { /* Repair installs may have no valid prior build. */ }
		if (previous) writeJsonAtomically(assertLocalPath(root, RELEASE_READY_MANIFEST), previous);
		const manifest = { schema: 1, state: "ready", ...build, previous, finishedAt: new Date().toISOString() };
		writeJsonAtomically(assertLocalPath(root, `${buildDir}.owner.json`), { schema: 1, buildDir, state: "ready" });
		writeJsonAtomically(active, manifest);
		promoted = true;
		try { writeJsonAtomically(assertLocalPath(root, RELEASE_READY_MANIFEST), manifest); } catch (error) { warn(`[piweb] Build ready, but its recovery selection could not be saved: ${error.message}`); }
		return true;
	} finally {
		if (outputDir && !promoted) {
			try { fs.writeFileSync(assertLocalPath(root, `${outputDir}.owner.json`), JSON.stringify({ schema: 1, buildDir: outputDir, state: "failed" })); } catch { /* Keep the ownership marker for manual recovery. */ }
		}
		// 复制兜底时 staging 里是整份 node_modules，必须删掉；rmSync 跟随链接删除
		// 的是链接本身（Node 14+ 目录符号链接不穿透），真实依赖不受影响。
		fs.rmSync(staging, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
	}
}

/**
 * Build once when a production-only install has no build yet.
 * @returns {"skipped" | "built" | "failed"}
 */
export function ensureInstallBuild(root, { log = console.log, warn = console.warn, force = false, sourceRoot = root } = {}) {
	if (process.env.PIWEB_SKIP_INSTALL_BUILD === "1") return "skipped";
	if (!force && hasProductionBuild(root)) return "skipped";
	if (!force && !isProductionOnlyInstall(root)) return "skipped";

	const nextBin = resolveNextBin(root);
	if (!nextBin) {
		warn("[piweb] Next.js is missing from this installation; cannot prepare a production build.");
		return "failed";
	}

	log("[piweb] Preparing the production build for this installation (one time, takes a minute or two)...");
	const started = Date.now();
	let built;
	let buildLock;
	try {
		assertReleaseCapacity(root);
		buildLock = acquireFileLock(assertLocalPath(root, `${RELEASES_DIR}/update.lock`));
		built = buildInStaging(root, nextBin, {
		...process.env,
		PIWEB_BUILD_LOCK_FILE: assertLocalPath(root, `${RELEASES_DIR}/update.lock`), PIWEB_BUILD_LOCK_TOKEN: buildLock.token,
		NEXT_TELEMETRY_DISABLED: "1",
		NODE_OPTIONS: [process.env.NODE_OPTIONS, "--max-old-space-size=8192"].filter(Boolean).join(" "),
	}, log, warn, sourceRoot); }
	catch (error) { warn(`[piweb] Production build failed: ${error.message}`); return "failed"; }
	finally { buildLock?.(); }

	if (!built) {
		warn("[piweb] Production build failed. Retry with: npm rebuild -g @rexvane/piweb");
		return "failed";
	}
	log(`[piweb] Build ready in ${((Date.now() - started) / 1000).toFixed(0)}s.`);
	return "built";
}
