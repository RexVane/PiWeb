import { isIP } from "node:net";

/**
 * 同源校验。跨站一律拒绝（Sec-Fetch-Site 由浏览器给出，脚本改不了），
 * 没有 Origin 的请求（curl、服务端调用）放行。
 */
export function isSafeOrigin(request: Request): boolean {
	if (request.headers.get("sec-fetch-site") === "cross-site") return false;
	const origin = request.headers.get("origin");
	if (!origin) return true;
	try {
		const originUrl = new URL(origin);
		const expectedHost = request.headers.get("host") || new URL(request.url).host;
		return originUrl.host.toLowerCase() === expectedHost.toLowerCase();
	} catch {
		return false;
	}
}

export function trustedHostnames(raw: string | undefined): string[] {
	return (raw ?? "").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
}

/**
 * 白名单环境变量。PI_WEB_TRUSTED_HOSTS 是本项目的名字，PI_WEB_ALLOWED_HOSTS 是上游
 * agegr/pi-web 的名字，两个都收，免得用户按上游文档配置却不生效。
 */
export function configuredTrustedHosts(env: Record<string, string | undefined> = process.env): string[] {
	return [...trustedHostnames(env.PI_WEB_TRUSTED_HOSTS), ...trustedHostnames(env.PI_WEB_ALLOWED_HOSTS)];
}

/**
 * Host 校验：无论有没有开认证都要做。
 *
 * 只信任本机名（含 *.localhost）、IP 字面量、以及操作者显式列出的主机名。
 * IP 字面量保留局域网直连能力，且不可能被 DNS rebinding 利用 —— 浏览器会把字面
 * 地址原样写进 Host，攻击者域名对不上。反代转发的域名必须进白名单：
 * DNS rebinding 靠的是攻击者域名解析到回环后仍带自己的 Host，它不可能等于白名单里的名字。
 */
export function isSafeHost(request: Request, trustedHosts: readonly string[] = []): boolean {
	try {
		const host = request.headers.get("host") || new URL(request.url).host;
		const parsed = new URL(`http://${host}`);
		if (parsed.username || parsed.password || parsed.host.toLowerCase() !== host.toLowerCase()) return false;
		const hostname = parsed.hostname.toLowerCase();
		if (isLoopbackHostname(hostname)) return true;
		if (isIP(hostname) !== 0) return true;
		return trustedHosts.includes(hostname);
	} catch {
		return false;
	}
}

export function isLoopbackHostname(hostname: string): boolean {
	const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
	if (host === "localhost" || host.endsWith(".localhost")) return true;
	return host === "::1" || host === "0:0:0:0:0:0:0:1" || /^127(?:\.\d{1,3}){3}$/.test(host);
}
