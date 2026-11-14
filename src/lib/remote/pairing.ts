/**
 * 扫码登录的一次性凭据。二维码与复制链接共用它，120 秒过期、用后作废。
 *
 * 为什么要有它：PiWeb 的认证凭据是启动令牌，等于主人身份。二维码会被截图、投屏、录制，
 * 把长期令牌印进二维码等于把钥匙印在纸上。所以二维码里只放随机的临时凭据：
 *   - 只在内存里，进程重启即失效；
 *   - 默认 120 秒过期；
 *   - 用一次就作废；
 *   - 发放与兑换都有速率上限，防止被本地脚本刷。
 *
 * 这里不碰档案目录、不写任何文件 —— 配对是纯运行时状态，和 pi 的会话/设置无关。
 */
import { randomBytes } from "node:crypto";

/** 一次性短码有效期 */
export const PAIR_TTL_MS = 120_000;

/** 同时最多保留几个待兑换的短码（够手机连续试几次，又不至于让屏幕上的旧码一直有效） */
const MAX_PENDING = 3;

/** 一个时间窗内最多发放几个（按本机使用者的正常节奏，够用且能挡住刷） */
const ISSUE_WINDOW_MS = 60_000;
const ISSUE_LIMIT = 6;

const VERIFY_WINDOW_MS = 60_000;
const VERIFY_LIMIT = 30;
const CODE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

type Reason = "expired" | "unknown" | "rate-limited";

interface Entry {
	code: string;
	issuedAt: number;
	expiresAt: number;
	revocationEpoch: number;
}

interface PairingState {
	pending: Map<string, Entry>;
	issuedAt: number[];
	failedAt: number[];
}

// 路由分包和开发热重载必须看到同一批凭据；版本键不复用旧的六位数字短码。
const stateKey = Symbol.for("piweb:pairing:v4");
function state(): PairingState {
	const store = globalThis as Record<PropertyKey, unknown>;
	return (store[stateKey] ??= { pending: new Map(), issuedAt: [], failedAt: [] }) as PairingState;
}

export type PairIssue = { code: string; expiresAt: number };
export type PairVerify = { ok: true } | { ok: false; reason: Reason; retryAfterSeconds?: number };

export class PairingError extends Error {
	constructor(readonly reason: "rate-limited" | "too-many-pending") {
		super(reason);
		this.name = "PairingError";
	}
}

function purge(now: number, notBefore = 0): void {
	const { pending, issuedAt, failedAt } = state();
	for (const [code, entry] of pending) {
		if (entry.expiresAt <= now || entry.revocationEpoch !== notBefore) pending.delete(code);
	}
	while (issuedAt.length > 0 && now - issuedAt[0] > ISSUE_WINDOW_MS) issuedAt.shift();
	while (failedAt.length > 0 && now - failedAt[0] >= VERIFY_WINDOW_MS) failedAt.shift();
}

/** 发一个短码。抛出 PairingError 表示被限流。 */
export function issuePairCode(now = Date.now(), notBefore = 0): PairIssue {
	purge(now, notBefore);
	const { pending, issuedAt } = state();
	if (issuedAt.length >= ISSUE_LIMIT) throw new PairingError("rate-limited");
	if (pending.size >= MAX_PENDING) throw new PairingError("too-many-pending");
	let code = "";
	do {
		code = randomBytes(32).toString("base64url");
	} while (pending.has(code));
	const expiresAt = now + PAIR_TTL_MS;
	pending.set(code, { code, issuedAt: now, expiresAt, revocationEpoch: notBefore });
	issuedAt.push(now);
	return { code, expiresAt };
}

/** 页面轮询复用尚有效的凭据；用后或过期才换新，切换网络地址也不额外消耗配额。 */
export function refreshPairCode(previous: unknown, now = Date.now(), notBefore = 0): PairIssue {
	// Another PiWeb instance can commit logout without clearing this process's map.
	// The generation also rejects codes issued while that commit was pending.
	purge(now, notBefore);
	if (typeof previous === "string" && CODE_PATTERN.test(previous)) {
		const entry = state().pending.get(previous);
		if (entry && entry.expiresAt > now) return { code: entry.code, expiresAt: entry.expiresAt };
	}
	// 重新打开面板、多个已登录页面或被取消的请求共用现有码，避免自动展示耗尽发码配额。
	for (const entry of state().pending.values()) {
		if (entry.expiresAt > now) return { code: entry.code, expiresAt: entry.expiresAt };
	}
	return issuePairCode(now, notBefore);
}

/** 兑换短码：成功即作废（一次性）。过期与不存在分开报，方便界面提示“码过期了”而不是“码错了”。 */
export function verifyPairCode(raw: string, now = Date.now(), notBefore = 0): PairVerify {
	const code = String(raw ?? "").trim();
	const { pending, failedAt } = state();
	const entry = CODE_PATTERN.test(code) ? pending.get(code) : undefined;
	if (entry && entry.expiresAt > now && entry.revocationEpoch === notBefore) {
		// 已持有 256 位随机凭据的设备不是在猜码。匿名失败流量不能锁住合法扫码。
		pending.delete(code);
		return { ok: true };
	}
	if (entry) pending.delete(code);
	purge(now, notBefore);
	if (failedAt.length >= VERIFY_LIMIT) {
		return { ok: false, reason: "rate-limited", retryAfterSeconds: Math.max(1, Math.ceil((failedAt[0] + VERIFY_WINDOW_MS - now) / 1000)) };
	}
	failedAt.push(now);
	return { ok: false, reason: entry ? "expired" : "unknown" };
}

/** Revokes pending credentials without resetting anonymous-attempt throttling. */
export function invalidatePairCodes(): void { state().pending.clear(); }

/** 仅供测试：清空状态 */
export function resetPairingState(): void {
	const { pending, issuedAt, failedAt } = state();
	pending.clear();
	issuedAt.length = 0;
	failedAt.length = 0;
}

/** 仅供测试：还有几个待兑换 */
export function pendingPairCount(): number {
	return state().pending.size;
}
