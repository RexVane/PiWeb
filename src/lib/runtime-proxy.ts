import { EventEmitter } from "node:events";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { applyProxyEnv, deleteEnvValue, readEnvValue, type ProxyEnvMap } from "../../scripts/proxy-env.mjs";
import { runtimeRequire } from "../../scripts/runtime-require.mjs";
import { readSystemProxy, type SystemProxy } from "../../scripts/system-proxy.mjs";

const DISPATCHER_TIMEOUT_MS = 300_000;
const AUTO_SELECT_ATTEMPT_TIMEOUT_MS = 2_000;
const DEFAULT_LOCAL_NO_PROXY = "localhost,127.0.0.1,::1";

interface UndiciDispatcher {
	close?: () => Promise<void>;
	on?: (event: string, listener: (...args: unknown[]) => void) => void;
}

export interface UndiciModule {
	Agent: new (options?: Record<string, unknown>) => UndiciDispatcher;
	EnvHttpProxyAgent: new (options?: Record<string, unknown>) => UndiciDispatcher;
	setGlobalDispatcher: (dispatcher: UndiciDispatcher) => void;
	getGlobalDispatcher?: () => UndiciDispatcher | undefined;
}

export interface ApplyRuntimeProxyOptions {
	env?: ProxyEnvMap;
	nodeVersion?: string;
	readSystemProxy?: () => SystemProxy | null;
	loadUndici?: () => UndiciModule | null;
	httpModule?: Pick<typeof http, "Agent" | "globalAgent">;
	httpsModule?: Pick<typeof https, "Agent" | "globalAgent">;
}

export interface RuntimeProxyResult {
	proxy: string | null;
	source: "settings" | "env" | "system" | "direct" | "none";
	supported: boolean;
	activeInProcess: boolean;
}

let managedDispatcher: UndiciDispatcher | null = null;

function loadUndici(): UndiciModule | null {
	try {
		return runtimeRequire(import.meta.url)("undici") as UndiciModule;
	} catch {
		try {
			const root = process.env.PI_WEB_ROOT ? path.resolve(process.env.PI_WEB_ROOT) : process.cwd();
			const agentPkg = path.join(root, "node_modules", "@earendil-works", "pi-coding-agent", "package.json");
			return runtimeRequire(pathToFileURL(agentPkg).href)("undici") as UndiciModule;
		} catch {
			return null;
		}
	}
}

function attachNoopErrorListener(dispatcher: UndiciDispatcher): void {
	if (dispatcher instanceof EventEmitter || typeof dispatcher.on === "function") {
		dispatcher.on?.("error", () => {});
	}
}

function replaceGlobalAgents(
	httpMod: Pick<typeof http, "Agent" | "globalAgent">,
	httpsMod: Pick<typeof https, "Agent" | "globalAgent">,
	proxyEnv: Record<string, string | undefined> | undefined,
): void {
	const common = { keepAlive: true, scheduling: "lifo" as const, timeout: 5000 };
	const options = (proxyEnv ? { ...common, proxyEnv } : common) as http.AgentOptions;
	httpMod.globalAgent = new httpMod.Agent(options);
	httpsMod.globalAgent = new httpsMod.Agent(options as https.AgentOptions);
}

/**
 * Update runtime proxy env vars, undici global dispatcher, and Node http(s) globalAgents
 * so new requests use the updated setting immediately without restarting PiWeb.
 */
export function applyRuntimeProxy(proxySetting: string, options: ApplyRuntimeProxyOptions = {}): RuntimeProxyResult {
	const env = options.env ?? (process.env as ProxyEnvMap);
	const proxy = proxySetting.trim() || null;
	const previousSource = env.PIWEB_PROXY_SOURCE;

	if (env.PIWEB_INHERITED_HTTP_PROXY === undefined && env.PIWEB_INHERITED_HTTPS_PROXY === undefined) {
		const managedAtStartup = previousSource === "settings" || previousSource === "system" || previousSource === "direct";
		env.PIWEB_INHERITED_HTTP_PROXY = managedAtStartup ? "" : readEnvValue(env, "HTTP_PROXY");
		env.PIWEB_INHERITED_HTTPS_PROXY = managedAtStartup ? "" : readEnvValue(env, "HTTPS_PROXY");
	}

	deleteEnvValue(env, "HTTP_PROXY");
	deleteEnvValue(env, "HTTPS_PROXY");
	const inheritedHttp = String(env.PIWEB_INHERITED_HTTP_PROXY ?? "").trim();
	const inheritedHttps = String(env.PIWEB_INHERITED_HTTPS_PROXY ?? "").trim();
	if (proxy !== "direct") {
		if (inheritedHttp) env.HTTP_PROXY = inheritedHttp;
		if (inheritedHttps) env.HTTPS_PROXY = inheritedHttps;
	}

	if (env.PIWEB_MANAGED_NO_PROXY === "1" || ((previousSource === "settings" || previousSource === "system") && readEnvValue(env, "NO_PROXY") === DEFAULT_LOCAL_NO_PROXY)) {
		deleteEnvValue(env, "NO_PROXY");
		delete env.PIWEB_MANAGED_NO_PROXY;
	}
	if (env.PIWEB_MANAGED_NODE_USE_ENV_PROXY === "1") {
		delete env.NODE_USE_ENV_PROXY;
		delete env.PIWEB_MANAGED_NODE_USE_ENV_PROXY;
	}

	const systemProxy = !proxy && !inheritedHttp && !inheritedHttps ? (options.readSystemProxy ?? readSystemProxy)() : null;
	const hadNoProxy = env.NO_PROXY !== undefined || env.no_proxy !== undefined;
	const hadUseEnvProxy = String(env.NODE_USE_ENV_PROXY ?? "").trim() !== "";
	const applied = applyProxyEnv(env, { proxySetting: proxy, systemProxy, nodeVersion: options.nodeVersion });
	const source = applied.source ?? "none";
	env.PIWEB_PROXY_SOURCE = source;

	if (!hadNoProxy && (env.NO_PROXY !== undefined || env.no_proxy !== undefined)) {
		env.PIWEB_MANAGED_NO_PROXY = "1";
	}
	if (!hadUseEnvProxy && env.NODE_USE_ENV_PROXY !== undefined) {
		env.PIWEB_MANAGED_NODE_USE_ENV_PROXY = "1";
	}

	if (applied.proxy && !applied.supported) {
		return { proxy: applied.proxy, source, supported: false, activeInProcess: false };
	}

	const explicitOptOut = String(env.NODE_USE_ENV_PROXY ?? "").trim() === "0";
	const useProxyInProcess = Boolean(applied.proxy && applied.supported && !explicitOptOut);
	const httpMod = options.httpModule ?? http;
	const httpsMod = options.httpsModule ?? https;
	const undici = (options.loadUndici ?? loadUndici)();

	const baseDispatcherOptions = {
		allowH2: false,
		bodyTimeout: DISPATCHER_TIMEOUT_MS,
		headersTimeout: DISPATCHER_TIMEOUT_MS,
		connect: { autoSelectFamilyAttemptTimeout: AUTO_SELECT_ATTEMPT_TIMEOUT_MS },
	};

	if (useProxyInProcess) {
		const httpProxy = readEnvValue(env, "HTTP_PROXY") || undefined;
		const httpsProxy = readEnvValue(env, "HTTPS_PROXY") || undefined;
		const noProxy = readEnvValue(env, "NO_PROXY");
		replaceGlobalAgents(httpMod, httpsMod, {
			HTTP_PROXY: httpProxy,
			HTTPS_PROXY: httpsProxy,
			NO_PROXY: noProxy || undefined,
		});
		if (!undici) {
			return { proxy: applied.proxy, source, supported: applied.supported, activeInProcess: false };
		}
		const nextDispatcher = new undici.EnvHttpProxyAgent({
			...baseDispatcherOptions,
			proxyTunnel: true,
			httpProxy,
			httpsProxy,
			noProxy,
		});
		attachNoopErrorListener(nextDispatcher);
		const previousManaged = managedDispatcher;
		undici.setGlobalDispatcher(nextDispatcher);
		managedDispatcher = nextDispatcher;
		if (previousManaged && previousManaged !== nextDispatcher) {
			void previousManaged.close?.().catch(() => undefined);
		}
		return { proxy: applied.proxy, source, supported: true, activeInProcess: true };
	}

	replaceGlobalAgents(httpMod, httpsMod, undefined);
	if (undici) {
		const nextDispatcher = new undici.Agent(baseDispatcherOptions);
		attachNoopErrorListener(nextDispatcher);
		const previousManaged = managedDispatcher;
		undici.setGlobalDispatcher(nextDispatcher);
		managedDispatcher = nextDispatcher;
		if (previousManaged && previousManaged !== nextDispatcher) {
			void previousManaged.close?.().catch(() => undefined);
		}
	} else if (managedDispatcher) {
		return { proxy: applied.proxy, source, supported: applied.supported, activeInProcess: false };
	}

	return { proxy: applied.proxy, source, supported: applied.supported, activeInProcess: true };
}
