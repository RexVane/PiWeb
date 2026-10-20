/** 公网探测必须读到 PiWeb 的健康响应；拿到域名、进程存活都不代表隧道能转发。 */
import https from "node:https";

export interface TunnelHealth {
	ready: boolean;
	error: string | null;
}

const unavailable = "公网入口暂时不可达，隧道仍在尝试重连。持续失败时请关闭后重新开启，并使用新地址。";

export function probeTunnel(url: string, signal: AbortSignal): Promise<TunnelHealth> {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (ready: boolean, error: string | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ ready, error });
		};
		const target = new URL(url);
		const request = https.request({ host: target.hostname, path: "/api/health", method: "GET", signal }, (response) => {
			if (response.headers["cf-mitigated"] === "challenge") {
				finish(false, "Cloudflare 要求浏览器验证，请在访问设备上打开公网地址完成验证。");
				response.destroy();
				return;
			}
			const chunks: Buffer[] = [];
			let size = 0;
			response.on("data", (chunk: Buffer) => {
				size += chunk.length;
				if (size > 16_384) {
					finish(false, "公网入口没有返回有效的 PiWeb 健康响应。");
					response.destroy();
				} else chunks.push(chunk);
			});
			response.on("error", () => finish(false, unavailable));
			response.on("end", () => {
				const body = Buffer.concat(chunks).toString("utf8");
				if (response.statusCode !== 200) {
					finish(false, /\b1033\b/.test(body)
						? "Cloudflare 1033：隧道未连接。请确认电脑联网且 PiWeb 正在运行；持续失败时关闭后重新开启，并使用新地址。"
						: `公网入口返回 HTTP ${response.statusCode ?? "?"}，尚未连通 PiWeb。`);
					return;
				}
				try {
					const health = JSON.parse(body);
					if (health?.success === true && health.data?.ok === true && health.data?.service === "piweb") {
						finish(true, null);
						return;
					}
				} catch { /* HTML 错误页或无效响应不能算就绪 */ }
				finish(false, "公网入口没有返回有效的 PiWeb 健康响应。");
			});
		});
		const timer = setTimeout(() => { finish(false, unavailable); request.destroy(); }, 8_000);
		timer.unref();
		request.on("error", () => finish(false, unavailable));
		request.end();
	});
}
