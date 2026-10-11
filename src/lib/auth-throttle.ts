/**
 * 登录失败的全局指数退避。
 *
 * PiWeb 只服务一个操作者，且默认绑 127.0.0.1：路由处理器拿不到可靠的客户端地址
 * （x-forwarded-for 可伪造，直连时根本没有）。与其信任一个按 IP 的键，不如让所有失败
 * 共用一个计数器，短暂挡住全部密码尝试。被误伤的「另一个用户」只有操作者本人，
 * 有界等待可以接受，而爆破被压到大约每分钟一次。
 *
 * 状态挂在 globalThis 上，这样 Next 的热重载不会把计数器重置掉。
 */

export const AUTH_THROTTLE_BASE_DELAY_MS = 1_000;
export const AUTH_THROTTLE_MAX_DELAY_MS = 60_000;

/**
 * 最后一次失败之后多久忘掉计数器。必须大于最大退避，否则「等过一次封禁」就
 * 等于把退避重置回基础值，反而给攻击者一轮新的尝试额度。
 */
export const AUTH_THROTTLE_RESET_AFTER_MS = 5 * 60_000;

export interface AuthThrottleState {
	failures: number;
	lastFailureAt: number;
	blockedUntil: number;
}

const STATE_KEY = "piweb:auth-throttle";

function freshState(): AuthThrottleState {
	return { failures: 0, lastFailureAt: 0, blockedUntil: 0 };
}

export function createAuthThrottleState(): AuthThrottleState {
	return freshState();
}

function isState(value: unknown): value is AuthThrottleState {
	return typeof value === "object"
		&& value !== null
		&& typeof (value as AuthThrottleState).failures === "number"
		&& typeof (value as AuthThrottleState).lastFailureAt === "number"
		&& typeof (value as AuthThrottleState).blockedUntil === "number";
}

function getGlobalState(): AuthThrottleState {
	const store = globalThis as Record<PropertyKey, unknown>;
	const key = Symbol.for(STATE_KEY);
	const existing = store[key];
	if (isState(existing)) return existing;
	const created = freshState();
	store[key] = created;
	return created;
}

function expireIfStale(state: AuthThrottleState, now: number): void {
	if (state.failures > 0 && now - state.lastFailureAt >= AUTH_THROTTLE_RESET_AFTER_MS) {
		Object.assign(state, freshState());
	}
}

export function backoffDelayMs(failures: number): number {
	if (failures <= 0) return 0;
	const exponent = Math.min(failures - 1, 31);
	return Math.min(AUTH_THROTTLE_BASE_DELAY_MS * 2 ** exponent, AUTH_THROTTLE_MAX_DELAY_MS);
}

/** 还要等多少毫秒才允许下一次尝试；0 表示可以试 */
export function getAuthRetryAfterMs(now = Date.now(), state: AuthThrottleState = getGlobalState()): number {
	expireIfStale(state, now);
	return Math.max(0, state.blockedUntil - now);
}

/** 记一次失败，返回下一次尝试被强制的等待时间 */
export function recordAuthFailure(now = Date.now(), state: AuthThrottleState = getGlobalState()): number {
	expireIfStale(state, now);
	state.failures += 1;
	state.lastFailureAt = now;
	const delay = backoffDelayMs(state.failures);
	state.blockedUntil = now + delay;
	return delay;
}

/**
 * 登录成功即清零（与上游 pi-web 的 recordAuthSuccess 一致）。
 * 攻击者不知道密码就不可能触发这条路径，所以清零不会削弱防护，
 * 而操作者输对一次之后不必继续背着之前的退避。
 */
export function recordAuthSuccess(state: AuthThrottleState = getGlobalState()): void {
	Object.assign(state, freshState());
}

/** 仅供测试：清掉挂在 globalThis 上的计数器 */
export function resetAuthThrottle(): void {
	Object.assign(getGlobalState(), freshState());
}

/** Retry-After 头的整秒值；被封禁时至少 1 */
export function retryAfterSeconds(retryAfterMs: number): number {
	return Math.max(1, Math.ceil(retryAfterMs / 1000));
}
