import path from "node:path";
import { pathToFileURL } from "node:url";
export function lockChildEnvironment(env, file = env.PIWEB_PROCESS_LOCK_FILE ?? env.PIWEB_BUILD_LOCK_FILE, token = env.PIWEB_PROCESS_LOCK_TOKEN ?? env.PIWEB_BUILD_LOCK_TOKEN) {
	if (!file && !token) return env;
	if (!file || !token) throw new Error("Incomplete process lock handoff");
	// Next may inline this helper in a server bundle; import.meta.url would then
	// name the build machine's source. The launcher supplies the installed root.
	const preload = `--import=${pathToFileURL(path.resolve(env.PI_WEB_ROOT ?? process.cwd(), "scripts", "lock-child.mjs")).href}`;
	const options = env.NODE_OPTIONS ?? "";
	return { ...env, PIWEB_PROCESS_LOCK_FILE: file, PIWEB_PROCESS_LOCK_TOKEN: token, NODE_OPTIONS: options.includes(preload) ? options : [options, preload].filter(Boolean).join(" ") };
}
