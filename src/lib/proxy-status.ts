import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readSystemProxy, type SystemProxy } from "../../scripts/system-proxy.mjs";

type ProxySource = "system" | "env" | "manual" | "direct" | "none";
export interface ProxyChoice {
	source: ProxySource;
	http: string | null;
	https: string | null;
}
export interface DetectedProxy {
	url: string;
	source: "system" | "env";
}
export type ProxyTestCode = "no_proxy" | "invalid" | "unsupported" | "timeout" | "unreachable" | "http" | "failed";
export interface ProxyTestResult {
	proxy: ProxyChoice;
	ok: boolean;
	latencyMs: number;
	code?: ProxyTestCode;
	status?: number;
}

const run = promisify(execFile);
export const PROXY_TEST_URL = "https://www.gstatic.com/generate_204";
const TIMEOUT_MS = 8_000;

/** Injected startup variables must not masquerade as the user's inherited proxy. */
export function automaticProxy(env: Record<string, string | undefined> = process.env, system = readSystemProxy()): ProxyChoice {
	const injected = env.PIWEB_PROXY_SOURCE === "system" || env.PIWEB_PROXY_SOURCE === "settings" || env.PIWEB_PROXY_SOURCE === "direct";
	const current = (name: string) => (injected ? env[`PIWEB_INHERITED_${name}`] || "" : env[name.toLowerCase()] || env[name] || "").trim() || null;
	const http = current("HTTP_PROXY");
	const https = current("HTTPS_PROXY");
	if (http || https) return { source: "env", http, https: https || http };
	if (system?.http || system?.https) return { source: "system", http: system.http ?? null, https: system.https ?? system.http ?? null };
	return { source: "none", http: null, https: null };
}

function redactOrigin(value: string | null | undefined): string | null {
	if (!value) return null;
	try {
		const url = new URL(value);
		url.username = ""; url.password = "";
		return url.origin;
	} catch { return null; }
}

/** Return distinct detected system and inherited environment proxies in priority order. */
export function detectedProxies(env: Record<string, string | undefined> = process.env, system: SystemProxy | null = readSystemProxy()): DetectedProxy[] {
	const items: DetectedProxy[] = [];
	const seen = new Set<string>();
	const add = (raw: string | null | undefined, source: "system" | "env") => {
		const origin = redactOrigin(raw);
		if (!origin || seen.has(origin)) return;
		seen.add(origin);
		items.push({ url: origin, source });
	};
	add(system?.https, "system");
	add(system?.http, "system");
	const injected = env.PIWEB_PROXY_SOURCE === "system" || env.PIWEB_PROXY_SOURCE === "settings" || env.PIWEB_PROXY_SOURCE === "direct";
	const envVar = (name: string) => (injected ? env[`PIWEB_INHERITED_${name}`] || "" : env[name.toLowerCase()] || env[name] || "").trim() || null;
	add(envVar("HTTPS_PROXY"), "env");
	add(envVar("HTTP_PROXY"), "env");
	return items;
}

export function publicProxy(choice: ProxyChoice): ProxyChoice {
	return { source: choice.source, http: redactOrigin(choice.http), https: redactOrigin(choice.https) };
}

/** Probe a direct connection without using any HTTP(S) proxy. */
export async function probeDirect(): Promise<{ ok: boolean; status?: number; code?: string }> {
	const env = { ...process.env, HTTP_PROXY: "", HTTPS_PROXY: "", http_proxy: "", https_proxy: "", NO_PROXY: "", no_proxy: "", NODE_USE_ENV_PROXY: "0" };
	const script = `try {
		const response = await fetch(${JSON.stringify(PROXY_TEST_URL)}, { method: "HEAD", redirect: "error", signal: AbortSignal.timeout(${TIMEOUT_MS}) });
		console.log(JSON.stringify({ok: response.status === 204, status: response.status}));
	} catch (error) {
		console.log(JSON.stringify({ok: false, code: error.cause?.code || error.name}));
	}`;
	const { stdout } = await run(process.execPath, ["--input-type=module", "-e", script], {
		env, windowsHide: true, timeout: TIMEOUT_MS + 2_000, maxBuffer: 4096,
	});
	return JSON.parse(stdout.trim());
}

/** A fresh child gives this probe its own proxy; there is no direct-network fallback. */
export async function probeThroughProxy(proxy: string): Promise<{ ok: boolean; status?: number; code?: string }> {
	const env = { ...process.env, HTTP_PROXY: proxy, HTTPS_PROXY: proxy, http_proxy: proxy, https_proxy: proxy,
		NO_PROXY: "", no_proxy: "", NODE_USE_ENV_PROXY: "1" };
	const script = `try {
		const response = await fetch(${JSON.stringify(PROXY_TEST_URL)}, { method: "HEAD", redirect: "error", signal: AbortSignal.timeout(${TIMEOUT_MS}) });
		console.log(JSON.stringify({ok: response.status === 204, status: response.status}));
	} catch (error) {
		console.log(JSON.stringify({ok: false, code: error.cause?.code || error.name}));
	}`;
	const { stdout } = await run(process.execPath, ["--input-type=module", "-e", script], {
		env, windowsHide: true, timeout: TIMEOUT_MS + 2_000, maxBuffer: 4096,
	});
	return JSON.parse(stdout.trim());
}

export async function testProxyConnection(input: string, {
	automatic = automaticProxy(), probe = probeThroughProxy, directProbe = probeDirect, nodeVersion = process.versions.node,
}: { automatic?: ProxyChoice; probe?: typeof probeThroughProxy; directProbe?: typeof probeDirect; nodeVersion?: string } = {}): Promise<ProxyTestResult> {
	const started = Date.now();
	const raw = input.trim();
	const isDirect = raw === "direct";
	const choice: ProxyChoice = isDirect
		? { source: "direct", http: null, https: null }
		: raw ? { source: "manual", http: raw, https: raw } : automatic;
	const result = (ok: boolean, code?: ProxyTestCode, status?: number): ProxyTestResult => ({
		proxy: publicProxy(choice), ok, latencyMs: Date.now() - started, ...(code ? { code } : {}), ...(status ? { status } : {}),
	});
	if (isDirect) {
		try {
			const response = await directProbe();
			if (response.ok && response.status === 204) return result(true, undefined, response.status);
			if (response.status) return result(false, "http", response.status);
			const code = response.code || "";
			return result(false, /TIMEOUT|Timeout|ABORT/i.test(code) ? "timeout"
				: /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ENETUNREACH/.test(code) ? "unreachable" : "failed");
		} catch (error) {
			return result(false, (error as NodeJS.ErrnoException & { killed?: boolean }).killed ? "timeout" : "failed");
		}
	}
	const proxy = choice.https || choice.http;
	if (!proxy) return result(false, "no_proxy");
	let url: URL;
	try { url = new URL(proxy); } catch { return result(false, "invalid"); }
	if (!/^https?:$/.test(url.protocol)) return result(false, "unsupported");
	if (proxy.length > 2048 || !url.hostname || url.port === "0" || url.pathname !== "/" || url.search || url.hash) return result(false, "invalid");
	const [major, minor] = nodeVersion.split(".").map(Number);
	if (major < 24 && !(major === 22 && minor >= 21)) return result(false, "unsupported");
	try {
		const response = await probe(proxy);
		if (response.ok && response.status === 204) return result(true, undefined, response.status);
		if (response.status) return result(false, "http", response.status);
		const code = response.code || "";
		return result(false, /TIMEOUT|Timeout|ABORT/i.test(code) ? "timeout"
			: /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ENETUNREACH/.test(code) ? "unreachable" : "failed");
	} catch (error) {
		return result(false, (error as NodeJS.ErrnoException & { killed?: boolean }).killed ? "timeout" : "failed");
	}
}
