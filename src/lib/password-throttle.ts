/**
 * 密码防爆破：登录表单与 HTTP Basic 各用一个实例（proxy 与路由处理器不共享模块状态）。
 * 整个进程共用一份额度，不按客户端分：Next 拿不到可信的客户端地址，按可伪造的请求头分桶
 * 等于让每次猜测都换一个新桶。只有“没见过的”错误密码消耗额度，浏览器反复带着旧的已保存
 * 密码不会把人锁在外面；额度用完时不再校验任何密码（猜中的也要拒绝，否则限速没有意义），
 * 已登录浏览器的会话 Cookie 不受影响。
 */
import { createHash, randomBytes } from "node:crypto";
import { NextResponse } from "next/server";

export type PasswordVerdict = "right" | "wrong" | { retryAfterMs: number };

export interface PasswordThrottleOptions {
	/** 连续可试的新错误密码个数 */
	burst?: number;
	/** 用完后每隔多久恢复一次机会 */
	refillMs?: number;
	now?: () => number;
	log?: (message: string) => void;
}

const REMEMBERED_WRONG = 256;

export function createPasswordThrottle({ burst = 10, refillMs = 30_000, now = () => performance.now(), log = console.warn }: PasswordThrottleOptions = {}) {
	const salt = randomBytes(16);
	/** 最近的错误密码（加盐摘要，按最近使用排序），重复出现不再扣额度 */
	const recentWrong = new Set<string>();
	let tokens = burst;
	let since = now();

	function refill(at: number) {
		if (tokens >= burst) {
			since = at;
			return;
		}
		const gained = Math.floor((at - since) / refillMs);
		if (gained <= 0) return;
		tokens = Math.min(burst, tokens + gained);
		since = tokens >= burst ? at : since + gained * refillMs;
	}

	return {
		check(candidate: string, isRight: (candidate: string) => boolean): PasswordVerdict {
			const key = createHash("sha256").update(salt).update(candidate).digest("base64");
			if (recentWrong.delete(key)) {
				recentWrong.add(key);
				return "wrong";
			}
			const at = now();
			refill(at);
			if (tokens <= 0) return { retryAfterMs: Math.max(1, since + refillMs - at) };
			if (isRight(candidate)) return "right";
			recentWrong.add(key);
			if (recentWrong.size > REMEMBERED_WRONG) recentWrong.delete(recentWrong.values().next().value!);
			tokens -= 1;
			if (tokens === 0) log(`[piweb] too many wrong passwords: password checks now allow one try every ${Math.round(refillMs / 1000)} s (signed-in browsers are not affected)`);
			return "wrong";
		},
	};
}

function retryAfterSeconds(retryAfterMs: number): number {
	return Math.max(1, Math.ceil(retryAfterMs / 1000));
}

/** 额度用完时的统一回应（没有校验这次的密码） */
export function passwordThrottledResponse(retryAfterMs: number): NextResponse {
	const seconds = retryAfterSeconds(retryAfterMs);
	return NextResponse.json(
		{ success: false, error: `too many wrong passwords; try again in ${seconds} s` },
		{ status: 429, headers: { "Retry-After": String(seconds), "Cache-Control": "no-store" } },
	);
}
