/**
 * 浏览器工具能打开哪些地址：只允许 http(s)，默认只放行本机与私网（开发服务器都在这里）。
 * 目的是不让 pi 借浏览器工具访问公网（只读预设本来就没有网络能力），不是硬安全边界：
 * 页面自己的跳转与请求不受限制；需要公网时设置 PI_WEB_BROWSER_ALLOW_PUBLIC=1。
 */
import dns from "node:dns/promises";
import { isIP } from "node:net";
import { isPublicAddress } from "../security/net-address";

export class BrowserUrlError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "BrowserUrlError";
	}
}

type Resolver = (hostname: string) => Promise<string[]>;

const resolveAll: Resolver = async (hostname) => (await dns.lookup(hostname, { all: true })).map((entry) => entry.address);

/** 校验并规范化地址；没写协议时补 http://（「localhost:5173」这种写法很常见） */
export async function checkBrowserUrl(raw: string, opts: { env?: Record<string, string | undefined>; resolve?: Resolver } = {}): Promise<URL> {
	const value = raw.trim();
	let url: URL;
	try {
		url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `http://${value}`);
	} catch {
		throw new BrowserUrlError(`invalid URL: ${raw}`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new BrowserUrlError(`only http(s) URLs can be opened, got ${url.protocol}`);
	if ((opts.env ?? process.env).PI_WEB_BROWSER_ALLOW_PUBLIC === "1") return url;
	const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
	if (host === "localhost" || host.endsWith(".localhost")) return url;
	const addresses = isIP(host) ? [host] : await (opts.resolve ?? resolveAll)(host).catch(() => {
		throw new BrowserUrlError(`cannot resolve ${host}`);
	});
	if (!addresses.length || addresses.some((address) => isPublicAddress(address))) {
		throw new BrowserUrlError(`${host} is a public address; the browser tools only open local / private-network pages (set PI_WEB_BROWSER_ALLOW_PUBLIC=1 to allow)`);
	}
	return url;
}
