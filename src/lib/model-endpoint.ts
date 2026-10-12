/**
 * 模型目录地址判断（客户端安全，纯函数）。
 *
 * ⚠️ 只用于界面提示：进了本机/私网地址就自动勾上「允许访问本机/私有网络地址」，
 * 免得用户对着 127.0.0.1 的网关反复点「获取可用模型」都被服务端挡回来。
 * 真正的闸门在服务端 requestModelCatalog 里（allowPrivate / PI_WEB_ALLOW_PRIVATE_MODEL_DISCOVERY），
 * 这里判错也不影响安全。
 */
export function looksPrivateEndpoint(url: string): boolean {
	try {
		const host = new URL(url.trim()).hostname.replace(/^\[|\]$/g, "").toLowerCase();
		if (!host) return false;
		if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
		if (host.includes(":")) return host === "::1" || /^(fc|fd|fe80)/.test(host);
		const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
		if (!v4) return false;
		const a = Number(v4[1]);
		const b = Number(v4[2]);
		return a === 0 || a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
	} catch {
		return false;
	}
}
