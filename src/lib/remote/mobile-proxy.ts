/**
 * 手机排版注入代理 —— 「远程连接」内置插件的数据面。
 *
 * 它只做一件事：往 PiWeb 的 HTML 里插一段样式与脚本，其它流量原样转发。
 * 注入只对非回环 Host 生效，所以本机直连的桌面页面拿到的仍是 PiWeb 原样。
 *
 * 流式是硬要求，不能图省事全缓冲：
 *  - /api/agent/<id>/events 是 SSE，缓冲住就等于聊天不流式了；
 *  - 图片提示词上传可以到 272MB，缓冲住就是内存爆炸。
 * 所以只有 content-type 是 text/html 的响应才读进内存做插入。
 *
 * 样式与脚本以 JSON 内联在 assets.json 里（不是运行时读盘）：这样 Next 的打包与
 * 文件追踪都不需要额外配置，发布包里也不会漏掉这两个文件。
 */
import http from "node:http";
import { pipeline } from "node:stream";
import zlib from "node:zlib";
import { isLoopbackHostname } from "../auth";
import assets from "./assets.json";

export const INJECT_ID = "piweb-mobile-fit";
export const MOBILE_FIT_CSS: string = assets.css;
export const MOBILE_FIT_JS: string = assets.js;

/** 去掉 Host 头里的端口；裸 IPv6 不能被冒号切坏 */
function hostWithoutPort(hostHeader: string | undefined): string {
	let host = String(hostHeader ?? "").trim().toLowerCase();
	if (host.startsWith("[")) {
		const end = host.indexOf("]");
		return end >= 0 ? host.slice(1, end) : host.slice(1);
	}
	// 只有一个冒号才是端口分隔符；::1 这种裸 IPv6 保持原样
	return (host.match(/:/g) ?? []).length === 1 ? host.slice(0, host.indexOf(":")) : host;
}

/** 请求是不是来自本机回环（决定要不要注入样式） */
export function isLoopbackHost(hostHeader: string | undefined): boolean {
	return isLoopbackHostname(hostWithoutPort(hostHeader));
}

export function decodeBody(buffer: Buffer, encoding: string | undefined): Buffer {
	const value = String(encoding ?? "").toLowerCase();
	if (!value || value === "identity") return buffer;
	if (value === "gzip" || value === "x-gzip") return zlib.gunzipSync(buffer);
	if (value === "deflate") return zlib.inflateSync(buffer);
	if (value === "br") return zlib.brotliDecompressSync(buffer);
	throw new Error(`不支持的 content-encoding：${encoding}`);
}

/** 在 </head> 前插入样式与脚本；没有 head 就插在 <body ...> 之后；再没有就前置。 */
export function injectAssets(html: string, { css = null, js = null }: { css?: string | null; js?: string | null } = {}): string {
	if (!css && !js) return html;
	if (html.includes(`id="${INJECT_ID}"`)) return html;
	const parts: string[] = [];
	if (css) parts.push(`<style id="${INJECT_ID}">\n${css}\n</style>`);
	if (js) parts.push(`<script id="${INJECT_ID}-js">\n${js}\n</script>`);
	const tag = parts.join("\n");
	const head = html.indexOf("</head>");
	if (head >= 0) return `${html.slice(0, head)}${tag}\n${html.slice(head)}`;
	const body = html.indexOf("<body");
	if (body >= 0) {
		const end = html.indexOf(">", body);
		if (end >= 0) return `${html.slice(0, end + 1)}${tag}${html.slice(end + 1)}`;
	}
	return tag + html;
}

/** @deprecated 保留旧名字，测试与调用方还在用 */
export function injectStyle(html: string, css: string): string {
	return injectAssets(html, { css });
}

export interface MobileProxyOptions {
	targetPort: number;
	targetHost?: string;
	css?: string | null;
	js?: string | null;
	log?: (message: string) => void;
}

export function createMobileProxy({ targetPort, targetHost = "127.0.0.1", css = null, js = null, log = () => {} }: MobileProxyOptions): http.Server {
	return http.createServer((req, res) => {
		// 保留原 Host / Origin 原样转发：PiWeb 的 isSafeHost 与 isSafeOrigin 都要看它们，
		// 改写成回环反而会让写操作被判成跨源。
		const headers: http.OutgoingHttpHeaders = { ...req.headers };
		const styled = Boolean(css || js) && !isLoopbackHost(headers.host as string | undefined);
		if (styled && String(headers.accept ?? "").includes("text/html")) {
			// 想插入就必须拿到未压缩的 HTML；静态资源不受影响，别拖慢传输
			headers["accept-encoding"] = "identity";
		}

		const upstream = http.request({ host: targetHost, port: targetPort, method: req.method, path: req.url ?? "/", headers }, (up) => {
			const type = String(up.headers["content-type"] ?? "");
			if (!styled || !type.includes("text/html")) {
				res.writeHead(up.statusCode ?? 502, up.headers);
				// pipeline 而不是 pipe：任一端提前断开都把另一端一起拆掉。
				// 手机切后台 / 断网时，到 PiWeb 的 SSE 连接必须跟着断，否则订阅者只增不减。
				pipeline(up, res, () => undefined);
				return;
			}
			const chunks: Buffer[] = [];
			up.on("error", (error) => {
				// 上游中途断开：已经没有完整的 HTML 可插，直接断掉，别让客户端一直挂着
				log(`[远程连接] 上游中途断开：${error.message}`);
				res.destroy();
			});
			up.on("data", (chunk: Buffer) => chunks.push(chunk));
			up.on("end", () => {
				const raw = Buffer.concat(chunks);
				let out: Buffer;
				try {
					out = Buffer.from(injectAssets(decodeBody(raw, up.headers["content-encoding"]).toString("utf8"), { css, js }), "utf8");
				} catch (error) {
					log(`[远程连接] 注入失败，原样返回：${error instanceof Error ? error.message : String(error)}`);
					const plain = { ...up.headers };
					delete plain["content-encoding"];
					delete plain["content-length"];
					res.writeHead(up.statusCode ?? 200, plain);
					res.end(raw);
					return;
				}
				const outHeaders = { ...up.headers };
				delete outHeaders["content-encoding"];
				// 上游多半是 chunked；既然我们给了确定的长度，两个头不能并存（否则客户端报
				// HPE_INVALID_CONTENT_LENGTH）。
				delete outHeaders["transfer-encoding"];
				delete outHeaders.etag; // 内容变了，原来的 ETag 不再成立
				outHeaders["content-length"] = String(out.byteLength);
				outHeaders["cache-control"] = "no-store";
				res.writeHead(up.statusCode ?? 200, outHeaders);
				res.end(out);
			});
		});
		let clientGone = false;
		upstream.on("error", (error) => {
			if (clientGone) return; // 是我们自己因为客户端走了才拆的，不是 PiWeb 连不上
			log(`[远程连接] 代理连不上 PiWeb：${error.message}`);
			if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
			res.end(`[远程连接] 连不上 PiWeb（${error.message}）`);
		});
		// 客户端在上游回应前就走了（或缓冲 HTML 时走了）：上游请求也撤掉，别继续占着 PiWeb
		res.on("close", () => {
			if (res.writableFinished) return;
			clientGone = true;
			upstream.destroy();
		});
		req.pipe(upstream);
	});
}
