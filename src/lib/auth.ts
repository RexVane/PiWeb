const BASIC_PREFIX = "Basic ";

/** 恒定时间字符串比较（长度不同也走完全程，不早退） */
export function equalText(left: string, right: string): boolean {
	const max = Math.max(left.length, right.length);
	let mismatch = left.length ^ right.length;
	for (let i = 0; i < max; i += 1) {
		mismatch |= (left.charCodeAt(i) || 0) ^ (right.charCodeAt(i) || 0);
	}
	return mismatch === 0;
}

export function validBasicAuthorization(header: string | null, password: string): boolean {
	if (!header?.startsWith(BASIC_PREFIX)) return false;
	try {
		const decoded = Buffer.from(header.slice(BASIC_PREFIX.length), "base64").toString("utf8");
		const separator = decoded.indexOf(":");
		if (separator < 0) return false;
		return equalText(decoded.slice(0, separator), "pi") && equalText(decoded.slice(separator + 1), password);
	} catch {
		return false;
	}
}

export function isSafeOrigin(request: Request): boolean {
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

/**
 * PI_WEB_TRUSTED_HOSTS：逗号分隔的主机名白名单。
 * 给只从回环反代的入口用（tailscale serve / 其它反代）：这类入口会把外部主机名原样转给后端，
 * 而它本身已经做了身份认证，所以这里放行即可，不需要再设 PI_WEB_PASSWORD。
 */
export function trustedHostnames(raw: string | undefined): string[] {
	return (raw ?? "").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
}

export function isSafeHost(request: Request, passwordConfigured: boolean, trustedHosts: readonly string[] = []): boolean {
	if (passwordConfigured) return true;
	try {
		const host = request.headers.get("host") || new URL(request.url).host;
		const parsed = new URL(`http://${host}`);
		if (parsed.username || parsed.password || parsed.host.toLowerCase() !== host.toLowerCase()) return false;
		if (isLoopbackHostname(parsed.hostname)) return true;
		// 精确匹配白名单。DNS rebinding 靠的是攻击者域名解析到回环后仍带自己的 Host，
		// 而它不可能等于白名单里的主机名，所以这项放行不削弱那层防护。
		return trustedHosts.includes(parsed.hostname.toLowerCase());
	} catch {
		return false;
	}
}

export function isLoopbackHostname(hostname: string): boolean {
	const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
	return host === "localhost" || host === "::1" || host === "0:0:0:0:0:0:0:1" || /^127(?:\.\d{1,3}){3}$/.test(host);
}
