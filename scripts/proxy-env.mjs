/** @typedef {Record<string, string | undefined>} ProxyEnvMap */
/** @typedef {import('./system-proxy.mjs').SystemProxy} SystemProxy */

/** Read an environment variable checking both original and lowercase keys. */
export function readEnvValue(env, name) {
	return String(env[name] ?? env[name.toLowerCase()] ?? "").trim();
}

/** Write an environment variable while maintaining Windows/POSIX letter-case entries. */
export function setEnvValue(env, name, value) {
	const lower = name.toLowerCase();
	if (env[lower] !== undefined) env[lower] = value;
	if (env[name] !== undefined || env[lower] === undefined) env[name] = value;
}

/** Delete both original and lowercase variants of an environment variable. */
export function deleteEnvValue(env, name) {
	delete env[name];
	delete env[name.toLowerCase()];
}

export function nodeSupportsEnvProxy(version = process.versions.node) {
	const [major, minor] = String(version).split(".").map(Number);
	return major >= 24 || (major === 22 && minor >= 21);
}

/**
 * 给服务进程配代理环境。pi 的 CLI 入口会做这两件事，而 PiWeb 走的是 SDK，得自己做，
 * 否则在 pi 终端里配好的代理到了网页端对模型请求完全不生效：
 *  1. 手动 `httpProxy` 优先，其次代理环境变量，再跟随 Windows 系统代理；
 *  2. 让 Node 的 fetch / http 认这些变量（NODE_USE_ENV_PROXY）——默认它们是被忽略的。
 * 本机地址默认不走代理（本地 llama.cpp / Ollama），用户自己设了 NO_PROXY 就照他的。
 * @param {ProxyEnvMap} childEnv 就地修改
 * @param {{proxySetting?: string | null, systemProxy?: SystemProxy | null, nodeVersion?: string}} [options]
 * @returns {{proxy: string | null, source: "env" | "settings" | "system" | null, supported: boolean}}
 */
export function applyProxyEnv(childEnv, { proxySetting = null, systemProxy = null, nodeVersion = process.versions.node } = {}) {
	// Windows 上环境变量不分大小写，但展开成普通对象后分：两种写法都要查，免得补出一个只差大小写的重复键
	const fromEnv = readEnvValue(childEnv, "HTTPS_PROXY") || readEnvValue(childEnv, "HTTP_PROXY");
	if (proxySetting) {
		setEnvValue(childEnv, "HTTP_PROXY", proxySetting);
		setEnvValue(childEnv, "HTTPS_PROXY", proxySetting);
	} else if (!fromEnv && systemProxy) {
		if (systemProxy.http) setEnvValue(childEnv, "HTTP_PROXY", systemProxy.http);
		if (systemProxy.https) setEnvValue(childEnv, "HTTPS_PROXY", systemProxy.https);
	}
	const proxy = proxySetting || fromEnv || systemProxy?.https || systemProxy?.http || null;
	if (!proxy) return { proxy: null, source: null, supported: true };
	const source = proxySetting ? "settings" : fromEnv ? "env" : "system";
	const supported = nodeSupportsEnvProxy(nodeVersion);
	if (supported) {
		// 用户自己表过态（哪怕是 0）就尊重
		if (!String(childEnv.NODE_USE_ENV_PROXY ?? "").trim()) childEnv.NODE_USE_ENV_PROXY = "1";
		if (childEnv.NO_PROXY === undefined && childEnv.no_proxy === undefined) {
			childEnv.NO_PROXY = source === "system" && systemProxy?.noProxy === "*" ? "*"
				: ["localhost,127.0.0.1,::1", source === "system" ? systemProxy?.noProxy : null].filter(Boolean).join(",");
		}
	}
	return { proxy, source, supported };
}
