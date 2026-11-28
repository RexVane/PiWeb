/** Third-party installers must never inherit browser tokens or process injection. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Current agent proxy setting, shared without importing launcher-only file paths. */
export function readHttpProxySetting(env = process.env) {
	const raw = env.PI_CODING_AGENT_DIR;
	const home = os.homedir();
	const root = !raw ? path.join(home, ".pi", "agent") : raw === "~" ? home
		: /^~[\\/]/.test(raw) ? path.join(home, raw.slice(2)) : raw;
	try {
		const parsed = JSON.parse(fs.readFileSync(path.join(root, "settings.json"), "utf8").replace(/^\uFEFF/, ""));
		const configured = typeof parsed?.httpProxy === "string" ? parsed.httpProxy.trim() : "";
		if (configured) return configured;
	} catch { /* fallback to web-proxy.json */ }
	try {
		const webProxy = JSON.parse(fs.readFileSync(path.join(root, "web-proxy.json"), "utf8").replace(/^\uFEFF/, ""));
		if (webProxy?.mode === "direct") return "direct";
	} catch { /* no web-proxy.json */ }
	return null;
}

export const OFFICIAL_REGISTRY = "https://registry.npmjs.org";
export const OFFICIAL_REGISTRY_ARGS = Object.freeze([
	`--registry=${OFFICIAL_REGISTRY}`, `--@earendil-works:registry=${OFFICIAL_REGISTRY}`, `--@rexvane:registry=${OFFICIAL_REGISTRY}`,
]);
export function isolatedCommandEnv(env = process.env) {
	const allowed = /^(?:PATH|PATHEXT|SystemRoot|WINDIR|ComSpec|TEMP|TMP|TMPDIR|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|HOMEDRIVE|HOMEPATH|LANG|LC_ALL|HTTP_PROXY|HTTPS_PROXY|NO_PROXY|http_proxy|https_proxy|no_proxy)$/i;
	const result = Object.fromEntries(Object.entries(env).filter(([key, value]) => allowed.test(key) && typeof value === "string"));
	return { ...result, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8", NEXT_TELEMETRY_DISABLED: "1", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null" };
}
export function exactRegistryVersion(raw) {
	const value = raw.trim();
	if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(value)) throw new Error("registry returned an invalid package version");
	return value;
}
