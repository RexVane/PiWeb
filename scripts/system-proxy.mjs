import { execFileSync } from "node:child_process";
import path from "node:path";

/** @typedef {{http?: string, https?: string, noProxy?: string}} SystemProxy */

function proxyUrl(value) {
	if (!value) return undefined;
	try {
		const url = new URL(value.includes("://") ? value : `http://${value}`);
		if (!/^https?:$/.test(url.protocol) || !url.hostname || url.pathname !== "/" || url.search || url.hash) return undefined;
		return url.href.replace(/\/$/, "");
	} catch { return undefined; }
}

/** Read the current user's enabled Windows HTTP(S) proxy, without changing system settings. */
export function parseWindowsProxy(output) {
	const values = Object.fromEntries(Array.from(String(output).matchAll(/^\s*(ProxyEnable|ProxyServer|ProxyOverride)\s+REG_(?:DWORD|SZ|EXPAND_SZ)\s+(.+?)\s*$/gm), (match) => [match[1], match[2]]));
	if (!/^(?:0x0*1|1)$/i.test(values.ProxyEnable ?? "")) return null;
	const server = values.ProxyServer ?? "";
	/** @type {SystemProxy} */
	const result = {};
	if (server.includes("=")) {
		for (const entry of server.split(";")) {
			const match = entry.trim().match(/^(https?)\s*=\s*(.+)$/i);
			if (match) result[match[1].toLowerCase()] = proxyUrl(match[2].trim());
		}
	} else {
		result.http = result.https = proxyUrl(server.trim());
	}
	if (!result.http && !result.https) return null;
	// NO_PROXY understands exact hosts and domain suffixes. Windows-only patterns
	// such as <local> and 192.168.* cannot be represented by Node's env proxy.
	const bypass = (values.ProxyOverride ?? "").split(";").map((value) => value.trim()).filter((value) =>
		value && !/[<>\s]/.test(value) && (value === "*" || !value.replace(/^\*\./, "").includes("*")));
	if (bypass.length) result.noProxy = bypass.includes("*") ? "*" : bypass.join(",");
	return result;
}

/** @returns {SystemProxy | null} */
export function readSystemProxy({ platform = process.platform, run = execFileSync } = {}) {
	if (platform !== "win32") return null;
	try {
		const output = run(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "reg.exe"), [
			"query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
		], { encoding: "utf8", windowsHide: true, timeout: 1500, stdio: ["ignore", "pipe", "ignore"] });
		return parseWindowsProxy(output);
	} catch { return null; }
}
