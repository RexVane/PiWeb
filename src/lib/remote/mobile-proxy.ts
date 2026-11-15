/**
 * 手机排版注入代理 —— 「远程连接」内置插件的数据面。
 *
 * 它只做一件事：往 PiWeb 的 HTML 里插一段样式与脚本，其它流量原样转发。
 * 注入只对非回环 Host 生效，所以本机直连的桌面页面拿到的仍是 PiWeb 原样。
 *
 * 流式是硬要求，不能图省事全缓冲：
 *  - /api/agent/<id>/events 是 SSE，缓冲住就等于聊天不流式了；
 *  - 图片提示词上传可以到 272MB，缓冲住就是内存爆炸。
 * 所以只有 content-type 是 text/html 的响应才读进内存做插入，而且这条路径有三道上限：
 *  - 注入缓冲超过 PIWEB_MOBILE_PROXY_MAX_HTML_BYTES（默认 16MiB）就放弃注入、改为流式透传；
 *  - 解压输出超过 PIWEB_MOBILE_PROXY_MAX_DECODED_BYTES（默认 64MiB）直接 502（防压缩炸弹）；
 *  - 上游响应在 PIWEB_MOBILE_PROXY_TIMEOUT_MS（默认 30s）内没结束也放弃注入、改为流式透传。
 * 不支持的 content-encoding 不再删头假装明文，而是保留原编码头原样透传，避免把压缩字节当页面返回。
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

/** HTML 注入缓冲上限：超过就不再缓冲（页面可能几十 MB，全读进内存是内存 DoS） */
export const DEFAULT_MAX_HTML_BYTES = 16 * 1024 * 1024;
/** 解压输出上限：gzip 炸弹 65KB 能解出 64MiB，没有上限就能把代理进程内存打满 */
export const DEFAULT_MAX_DECODED_BYTES = 64 * 1024 * 1024;
/** 缓冲等待上游响应的总时长：超过就放弃注入改为流式透传（不改变正常页面的路径） */
export const DEFAULT_RESPONSE_TIMEOUT_MS = 30_000;

function positiveInteger(raw: string | undefined, fallback: number): number {
	const value = Number(raw);
	return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export function mobileProxyMaxHtmlBytes(env: Record<string, string | undefined> = process.env): number {
	return positiveInteger(env.PIWEB_MOBILE_PROXY_MAX_HTML_BYTES, DEFAULT_MAX_HTML_BYTES);
}

export function mobileProxyMaxDecodedBytes(env: Record<string, string | undefined> = process.env): number {
	return positiveInteger(env.PIWEB_MOBILE_PROXY_MAX_DECODED_BYTES, DEFAULT_MAX_DECODED_BYTES);
}

export function mobileProxyTimeoutMs(env: Record<string, string | undefined> = process.env): number {
	return positiveInteger(env.PIWEB_MOBILE_PROXY_TIMEOUT_MS, DEFAULT_RESPONSE_TIMEOUT_MS);
}

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

const SUPPORTED_ENCODINGS = new Set(["", "identity", "gzip", "x-gzip", "deflate", "br"]);

/** 支持的 content-encoding；不支持的必须原样透传（删掉编码头会把压缩字节当成明文页面） */
export function isSupportedEncoding(encoding: string | undefined): boolean {
	return SUPPORTED_ENCODINGS.has(String(encoding ?? "").toLowerCase());
}

/**
 * 解压 HTML。maxOutputBytes 是硬上限：超了让 zlib 直接抛错（ERR_BUFFER_TOO_LARGE），
 * 不要先解完再检查——那正是压缩炸弹要的。
 */
export function decodeBody(buffer: Buffer, encoding: string | undefined, maxOutputBytes?: number): Buffer {
	const value = String(encoding ?? "").toLowerCase();
	const options = maxOutputBytes !== undefined && Number.isSafeInteger(maxOutputBytes) && maxOutputBytes > 0
		? { maxOutputLength: maxOutputBytes }
		: undefined;
	if (!value || value === "identity") return buffer;
	if (value === "gzip" || value === "x-gzip") return zlib.gunzipSync(buffer, options);
	if (value === "deflate") return zlib.inflateSync(buffer, options);
	if (value === "br") return zlib.brotliDecompressSync(buffer, options);
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
	admitRequest?: (request: http.IncomingMessage, response: http.ServerResponse) => boolean;
	/** HTML 注入缓冲上限，默认 PIWEB_MOBILE_PROXY_MAX_HTML_BYTES（16MiB） */
	maxHtmlBytes?: number;
	/** 解压输出上限，默认 PIWEB_MOBILE_PROXY_MAX_DECODED_BYTES（64MiB） */
	maxDecodedBytes?: number;
	/** 缓冲等待上游响应的总时长，默认 PIWEB_MOBILE_PROXY_TIMEOUT_MS（30s） */
	responseTimeoutMs?: number;
}

export function createMobileProxy({ targetPort, targetHost = "127.0.0.1", css = null, js = null, log = () => {}, admitRequest, maxHtmlBytes, maxDecodedBytes, responseTimeoutMs }: MobileProxyOptions): http.Server {
	const htmlLimit = maxHtmlBytes ?? mobileProxyMaxHtmlBytes();
	const decodedLimit = maxDecodedBytes ?? mobileProxyMaxDecodedBytes();
	const timeoutLimit = responseTimeoutMs ?? mobileProxyTimeoutMs();
	// 转回 PiWeb 的这一跳必须直连。设了 NODE_USE_ENV_PROXY=1 时，Node 默认的 globalAgent 会把它交给
	// HTTP_PROXY，代理再按原样转发的 Host（局域网地址:入口端口）连回本入口——自己转给自己，直到本机端口耗尽，
	// 手机和公网隧道只能看到 502。自建的 Agent 不读代理环境变量；参数照抄 Node 的 globalAgent。
	const agent = new http.Agent({ keepAlive: true, scheduling: "lifo", timeout: 5000 });
	const server = http.createServer((req, res) => {
		if (admitRequest && !admitRequest(req, res)) return;
		// 保留原 Host / Origin 原样转发：PiWeb 的 isSafeHost 与 isSafeOrigin 都要看它们，
		// 改写成回环反而会让写操作被判成跨源。同时打上显式代理标记，禁止远程流量冒充本机直连。
		const headers: http.OutgoingHttpHeaders = { ...req.headers, "x-piweb-remote": "1" };
		const styled = Boolean(css || js) && !isLoopbackHost(headers.host as string | undefined);
		if (styled && String(headers.accept ?? "").includes("text/html")) {
			// 想插入就必须拿到未压缩的 HTML；静态资源不受影响，别拖慢传输
			headers["accept-encoding"] = "identity";
		}

		const upstream = http.request({ host: targetHost, port: targetPort, method: req.method, path: req.url ?? "/", headers, agent }, (up) => {
			const type = String(up.headers["content-type"] ?? "");
			const encoding = up.headers["content-encoding"];
			// 不支持的编码没法安全解压：保留原编码头原样流式透传（以前删头返回压缩字节，页面会乱码）
			const encodable = isSupportedEncoding(encoding);
			if (!styled || !type.includes("text/html") || !encodable) {
				res.writeHead(up.statusCode ?? 502, up.headers);
				// pipeline 而不是 pipe：任一端提前断开都把另一端一起拆掉。
				// 手机切后台 / 断网时，到 PiWeb 的 SSE 连接必须跟着断，否则订阅者只增不减。
				pipeline(up, res, () => undefined);
				return;
			}
			const chunks: Buffer[] = [];
			let bufferedBytes = 0;
			let handedOff = false;
			let timer: ReturnType<typeof setTimeout> | null = null;
			const clearTimer = () => {
				if (timer) { clearTimeout(timer); timer = null; }
			};
			/** 放弃注入但不让页面挂掉：把已经缓存的字节写完，剩下的上游响应继续流式转发 */
			const handOff = (reason: string) => {
				if (handedOff || res.headersSent || res.writableEnded || res.destroyed) return;
				handedOff = true;
				clearTimer();
				log(`[远程连接] ${reason}，改为流式透传（不注入）`);
				up.off("data", onData);
				up.off("end", onEnd);
				up.off("error", onUpstreamError);
				try {
					res.writeHead(up.statusCode ?? 200, up.headers);
				} catch (error) {
					log(`[远程连接] 透传响应头失败：${error instanceof Error ? error.message : String(error)}`);
					res.destroy();
					return;
				}
				for (const chunk of chunks) res.write(chunk);
				chunks.length = 0;
				pipeline(up, res, () => undefined);
			};
			timer = setTimeout(() => handOff(`上游响应超过 ${timeoutLimit}ms 仍未结束`), timeoutLimit);
			timer.unref?.();
			const onUpstreamError = (error: Error) => {
				// 上游中途断开：已经没有完整的 HTML 可插，直接断掉，别让客户端一直挂着
				clearTimer();
				log(`[远程连接] 上游中途断开：${error.message}`);
				res.destroy();
			};
			const onData = (chunk: Buffer) => {
				if (handedOff) return;
				chunks.push(chunk);
				bufferedBytes += chunk.length;
				if (bufferedBytes > htmlLimit) handOff(`HTML 超过注入缓冲上限 ${htmlLimit} 字节`);
			};
			const onEnd = () => {
				clearTimer();
				if (handedOff) return;
				const raw = Buffer.concat(chunks);
				chunks.length = 0;
				let out: Buffer;
				try {
					const decoded = decodeBody(raw, encoding, decodedLimit);
					out = Buffer.from(injectAssets(decoded.toString("utf8"), { css, js }), "utf8");
				} catch (error) {
					// zlib 的 maxOutputLength 超限固定抛 RangeError[ERR_BUFFER_TOO_LARGE]
					const tooLarge = (error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE";
					if (tooLarge) {
						// 解压炸弹：不转发，给一个能看懂的 502
						log(`[远程连接] 页面解压后超过上限 ${decodedLimit} 字节，已拒绝转发`);
						if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
						res.end(`[远程连接] 页面解压后超过上限（${decodedLimit} 字节），已拒绝转发。`);
						return;
					}
					// 解码失败（例如声称 gzip 实际不是）：保留原编码头，按原样字节透传，别返回乱码
					log(`[远程连接] 注入失败，按原编码原样透传：${error instanceof Error ? error.message : String(error)}`);
					res.writeHead(up.statusCode ?? 200, up.headers);
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
			};
			up.on("error", onUpstreamError);
			up.on("data", onData);
			up.on("end", onEnd);
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
		upstream.flushHeaders();
		req.pipe(upstream);
	});
	server.on("checkContinue", (req, res) => {
		if (admitRequest && !admitRequest(req, res)) return;
		res.writeContinue();
		server.emit("request", req, res);
	});
	server.on("checkExpectation", (_req, res) => { res.writeHead(417, { connection: "close" }); res.end(); });
	server.on("close", () => agent.destroy());
	return server;
}
