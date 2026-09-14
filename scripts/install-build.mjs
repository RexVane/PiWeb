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
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

export function hasProductionBuild(root) {
	return (
		fs.existsSync(path.join(root, ".next", "BUILD_ID")) ||
		fs.existsSync(path.join(root, ".next-releases", "active.json"))
	);
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
 */
function buildInStaging(root, nextBin, env, log, warn) {
	const parent = path.dirname(path.dirname(root));
	let staging;
	try {
		staging = fs.mkdtempSync(path.join(parent, ".piweb-build-"));
	} catch {
		staging = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-build-"));
	}
	try {
		for (const entry of ["src", "public", "assets", "scripts", "bin"]) {
			const from = path.join(root, entry);
			if (fs.existsSync(from)) fs.cpSync(from, path.join(staging, entry), { recursive: true });
		}
		for (const file of ["package.json", "tsconfig.json", "next.config.ts", "postcss.config.mjs"]) {
			const from = path.join(root, file);
			if (fs.existsSync(from)) fs.copyFileSync(from, path.join(staging, file));
		}
		try {
			fs.symlinkSync(path.join(root, "node_modules"), path.join(staging, "node_modules"), "junction");
		} catch (error) {
			warn(`[piweb] Could not link dependencies into the staging build: ${error.message}`);
			return false;
		}
		log(`[piweb] Building in ${staging} ...`);
		const result = spawnSync(process.execPath, [nextBin, "build", "--webpack"], { cwd: staging, stdio: "inherit", env });
		const produced = path.join(staging, ".next", "BUILD_ID");
		if (result.status !== 0 || !fs.existsSync(produced)) return false;
		const target = path.join(root, ".next");
		fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
		fs.cpSync(path.join(staging, ".next"), target, { recursive: true });
		return fs.existsSync(path.join(target, "BUILD_ID"));
	} finally {
		fs.rmSync(staging, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
	}
}

/**
 * Build once when a production-only install has no build yet.
 * @returns {"skipped" | "built" | "failed"}
 */
export function ensureInstallBuild(root, { log = console.log, warn = console.warn } = {}) {
	if (process.env.PIWEB_SKIP_INSTALL_BUILD === "1") return "skipped";
	if (hasProductionBuild(root)) return "skipped";
	if (!isProductionOnlyInstall(root)) return "skipped";

	const nextBin = resolveNextBin(root);
	if (!nextBin) {
		warn("[piweb] Next.js is missing from this installation; cannot prepare a production build.");
		return "failed";
	}

	log("[piweb] Preparing the production build for this installation (one time, takes a minute or two)...");
	const started = Date.now();
	const built = buildInStaging(root, nextBin, {
		...process.env,
		NEXT_TELEMETRY_DISABLED: "1",
		NODE_OPTIONS: [process.env.NODE_OPTIONS, "--max-old-space-size=8192"].filter(Boolean).join(" "),
	}, log, warn);

	if (!built) {
		warn("[piweb] Production build failed. Retry with: npm rebuild -g piweb");
		return "failed";
	}
	log(`[piweb] Build ready in ${((Date.now() - started) / 1000).toFixed(0)}s.`);
	return "built";
}
