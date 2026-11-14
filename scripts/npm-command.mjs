import fs from "node:fs";
import path from "node:path";
/** Run npm's JavaScript entrypoint directly; never reparse arguments in cmd.
 * @param {string[]} args
 * @param {Record<string, string | undefined>} env
 */
export function npmCommand(args, env = process.env) {
	const candidates = [env.npm_execpath, path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")];
	for (const directory of (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean)) {
		candidates.push(path.join(directory, "node_modules", "npm", "bin", "npm-cli.js"), path.resolve(directory, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"));
		try { candidates.push(fs.realpathSync(path.join(directory, "npm"))); } catch { /* No Unix npm symlink in this PATH entry. */ }
	}
	const cli = candidates.find((file) => typeof file === "string" && /(?:^|[\\/])npm-cli\.js$/i.test(file) && fs.existsSync(file));
	if (!cli) throw new Error("Cannot find npm-cli.js. Install npm alongside Node or set npm_execpath to its JavaScript entrypoint.");
	return { command: process.execPath, args: [cli, ...args] };
}
