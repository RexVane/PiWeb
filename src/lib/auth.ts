const BASIC_PREFIX = "Basic ";

function equalText(left: string, right: string): boolean {
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
		const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
		const expectedHost = forwardedHost || request.headers.get("host") || new URL(request.url).host;
		return originUrl.host.toLowerCase() === expectedHost.toLowerCase();
	} catch {
		return false;
	}
}

export function isLoopbackHostname(hostname: string): boolean {
	const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
	return host === "localhost" || host === "::1" || host === "0:0:0:0:0:0:0:1" || /^127(?:\.\d{1,3}){3}$/.test(host);
}
