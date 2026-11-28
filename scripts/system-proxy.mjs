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

function formatHostPort(host, port) {
	const trimmed = String(host ?? "").trim();
	const portNumber = Number(port);
	if (!trimmed || !Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) return undefined;
	const wrapped = trimmed.includes(":") && !trimmed.startsWith("[") ? `[${trimmed}]` : trimmed;
	return `${wrapped}:${portNumber}`;
}

/** Read the current user's enabled macOS HTTP(S) proxy from `scutil --proxy` output. */
export function parseMacProxy(output) {
	const text = String(output ?? "");
	const field = (name) => text.match(new RegExp(`^\\s*${name}\\s*:\\s*(.+?)\\s*$`, "m"))?.[1]?.trim();
	/** @type {SystemProxy} */
	const result = {};
	if (field("HTTPEnable") === "1") {
		const hostPort = formatHostPort(field("HTTPProxy"), field("HTTPPort"));
		if (hostPort) result.http = proxyUrl(hostPort);
	}
	if (field("HTTPSEnable") === "1") {
		const hostPort = formatHostPort(field("HTTPSProxy"), field("HTTPSPort"));
		if (hostPort) result.https = proxyUrl(hostPort);
	}
	if (!result.http && !result.https) return null;
	const exceptions = text.match(/^\s*ExceptionsList\s*:\s*(?:<array>\s*)?\{([\s\S]*?)^\s*\}/m)?.[1] ?? "";
	const bypass = Array.from(exceptions.matchAll(/^\s*\d+\s*:\s*(.+?)\s*$/gm))
		.map((match) => match[1].trim())
		.filter((value) => value && !/[<>\s/]/.test(value) && (value === "*" || !value.replace(/^\*\./, "").includes("*")));
	if (bypass.length) result.noProxy = bypass.includes("*") ? "*" : bypass.join(",");
	return result;
}

/** @returns {SystemProxy | null} */
export function readSystemProxy({ platform = process.platform, run = execFileSync } = {}) {
	if (platform === "win32") {
		try {
			const output = run(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "reg.exe"), [
				"query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
			], { encoding: "utf8", windowsHide: true, timeout: 1500, stdio: ["ignore", "pipe", "ignore"] });
			return parseWindowsProxy(output);
		} catch { return null; }
	}
	if (platform === "darwin") {
		try {
			const output = run("scutil", ["--proxy"], {
				encoding: "utf8", windowsHide: true, timeout: 1500, stdio: ["ignore", "pipe", "ignore"],
			});
			return parseMacProxy(output);
		} catch { return null; }
	}
	return null;
}
