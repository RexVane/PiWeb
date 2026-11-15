import fs from "node:fs";
import path from "node:path";
/**
 * Candidate npm JavaScript entrypoints for the running Node installation.
 * Exported so the supported installation layouts can be asserted without a real install.
 * @param {string} [execPath]
 * @param {Record<string, string | undefined>} [env]
 */
export function npmCliCandidates(execPath = process.execPath, env = process.env) {
	const execDir = path.dirname(execPath);
	const candidates = [
		env.npm_execpath,
		// Official Node.js Windows installs keep npm inside the Node directory.
		path.join(execDir, "node_modules", "npm", "bin", "npm-cli.js"),
		// POSIX layout used by setup-node, nvm, Homebrew and the official tarballs:
		// <prefix>/bin/node with npm at <prefix>/lib/node_modules/npm.
		path.resolve(execDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
	];
	if (process.platform !== "win32") {
		// Distro-packaged npm layouts (Debian/Ubuntu, Fedora, Arch, ...).
		candidates.push(
			"/usr/lib/node_modules/npm/bin/npm-cli.js",
			"/usr/local/lib/node_modules/npm/bin/npm-cli.js",
			"/usr/share/nodejs/npm/bin/npm-cli.js",
			"/usr/share/npm/bin/npm-cli.js",
		);
	}
	for (const directory of (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean)) {
		candidates.push(path.join(directory, "node_modules", "npm", "bin", "npm-cli.js"), path.resolve(directory, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"));
		try { candidates.push(fs.realpathSync(path.join(directory, "npm"))); } catch { /* No Unix npm symlink in this PATH entry. */ }
	}
	return candidates;
}
/** Run npm's JavaScript entrypoint directly; never reparse arguments in cmd.
 * @param {string[]} args
 * @param {Record<string, string | undefined>} env
 */
export function npmCommand(args, env = process.env) {
	const cli = npmCliCandidates(process.execPath, env).find((file) => typeof file === "string" && /(?:^|[\\/])npm-cli\.js$/i.test(file) && fs.existsSync(file));
	if (!cli) throw new Error("Cannot find npm-cli.js. Install npm alongside Node or set npm_execpath to its JavaScript entrypoint.");
	return { command: process.execPath, args: [cli, ...args] };
}
