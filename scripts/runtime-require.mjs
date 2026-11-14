import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
/** Native modules must resolve from the running installation, not Next's inlined
 * build-machine URL. A configured root is authoritative (no checkout fallback).
 * @param {string} moduleUrl
 * @param {{env?: Record<string, string | undefined>, cwd?: string}} options
 */
export function runtimeRequire(moduleUrl, { env = process.env, cwd = process.cwd() } = {}) {
	if (env.PI_WEB_ROOT) return createRequire(path.join(path.resolve(env.PI_WEB_ROOT), "package.json"));
	try {
		const file = fileURLToPath(moduleUrl);
		if (fs.statSync(file).isFile()) return createRequire(file);
	} catch { /* Foreign platform, missing build-machine source, or non-file URL. */ }
	return createRequire(path.join(path.resolve(cwd), "package.json"));
}
