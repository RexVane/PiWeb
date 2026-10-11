/**
 * 启动令牌（借鉴 deepseek-harness 的 launch token）。
 *
 * 每个进程启动时生成一次 32 字节随机值，由启动器打印成 `?token=…` 链接。
 * 浏览器用它换一张签名 Cookie，之后不再需要令牌。
 * 令牌不接受出现在 API 路径上，也不接受走 Authorization 头 —— 只有根路径的
 * GET 能消费它，这样令牌不会因为某个 API 客户端的日志而泄漏。
 */
import { timingSafeEqual } from "node:crypto";

export const TOKEN_QUERY = "token";
export const TOKEN_BYTES = 32;

/** 恒定时间比较；两边任一为空（没配令牌）时一律无效 */
export function validLaunchToken(candidate: string | undefined, expected: string | undefined): boolean {
	if (!candidate || !expected) return false;
	const actual = Buffer.from(candidate, "utf8");
	const wanted = Buffer.from(expected, "utf8");
	return actual.byteLength === wanted.byteLength && timingSafeEqual(actual, wanted);
}
