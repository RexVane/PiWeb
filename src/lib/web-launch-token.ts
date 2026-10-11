/**
 * 启动令牌（借鉴 deepseek-harness 的 launch token）。
 *
 * 每个进程启动时生成一次 32 字节随机值，由启动器打印成 `?token=…` 链接。
 * 浏览器用它换一张签名 Cookie，之后不再需要令牌。
 * 令牌不接受出现在 API 路径上，也不接受走 Authorization 头 —— 只有根路径的
 * GET 能消费它，这样令牌不会因为某个 API 客户端的日志而泄漏。
 */
import { timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { agentDir } from "./web-secret";

export const TOKEN_QUERY = "token";
export const TOKEN_BYTES = 32;

/** 恒定时间比较；两边任一为空（没配令牌）时一律无效 */
export function validLaunchToken(candidate: string | undefined, expected: string | undefined): boolean {
	if (!candidate || !expected) return false;
	const actual = Buffer.from(candidate, "utf8");
	const wanted = Buffer.from(expected, "utf8");
	return actual.byteLength === wanted.byteLength && timingSafeEqual(actual, wanted);
}

/**
 * 正在运行的实例把自己的启动令牌留在 `<agentDir>/web-launch/<端口>.token`。
 *
 * 用途只有一个：再次运行启动器、发现这个端口上已有 PiWeb 时，能直接打开带令牌的登录链接，
 * 而不是把用户扔到一个他手里没有凭据的登录页。文件和 web-secret 放在同一个目录、同样 0600：
 * 读得到它的人本来就读得到签名密钥，不额外扩大暴露面。路径规则与 scripts/launcher.mjs 一致。
 */
export function launchTokenFile(port: number | string): string {
	return path.join(agentDir(), "web-launch", `${port}.token`);
}

/** 服务启动时调用：写下本进程的令牌，退出时摘掉（只摘自己写的那份） */
export function publishLaunchToken(env: Record<string, string | undefined> = process.env): void {
	const token = env.PI_WEB_LAUNCH_TOKEN;
	const port = env.PIWEB_PORT;
	if (!token || !port) return;
	const file = launchTokenFile(port);
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
	} catch {
		return; // 只是便利功能：写不进去就退回旧行为（打开裸地址）
	}
	process.once("exit", () => {
		try {
			if (fs.readFileSync(file, "utf8").trim() === token) fs.unlinkSync(file);
		} catch {
			/* 已经不在了 */
		}
	});
}
