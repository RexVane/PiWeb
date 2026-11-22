/**
 * graceful-shutdown：进程级优雅停机（L5/L6）。
 *
 * 目标：收到 SIGINT/SIGTERM/SIGHUP 时，先让已注册的收尾动作跑完（停远程隧道/LAN 监听、
 * 等待已开始的落盘…），给它们一个有上限的时间窗口，再以「进程正常退出」
 * 的方式结束；只有第二次信号才立即退出。默认行为（无钩子、超时兜底、退出码）保持
 * Node 的原生语义：SIGINT=130、SIGTERM=143、SIGHUP=129。
 *
 * 谁注册：`src/lib/remote/supervisor.ts`（远程入口）
 * 。第一个注册会自动安装信号处理器——启动链里 instrumentation 总会 import
 * 这些模块，所以不需要额外改启动入口。状态挂 globalThis：Next 热重载/模块重求值不会
 * 重复安装处理器或丢钩子。
 */

type Hook = { name: string; run: () => unknown };

interface ShutdownState {
	hooks: Hook[];
	installed: boolean;
	running: Promise<void> | null;
	/** 已收到的退出信号次数：第二次开始不再等待。 */
	signals: number;
	/** 正在执行中的钩子，用来看超时后谁还没回来。 */
	active: Set<string>;
}

const STATE_KEY = Symbol.for("piweb.gracefulShutdown");
const DEFAULT_TIMEOUT_MS = 8_000;
const SIGNALS: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

function state(): ShutdownState {
	const store = globalThis as Record<PropertyKey, unknown>;
	let value = store[STATE_KEY] as ShutdownState | undefined;
	if (!value) {
		value = { hooks: [], installed: false, running: null, signals: 0, active: new Set() };
		store[STATE_KEY] = value;
	}
	return value;
}

/** 总停机预算（毫秒）：`PIWEB_SHUTDOWN_TIMEOUT_MS`，默认 8000。非法/<=0 用默认值。 */
export function shutdownTimeoutMs(): number {
	const raw = Number(process.env.PIWEB_SHUTDOWN_TIMEOUT_MS);
	return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_TIMEOUT_MS;
}

/** 信号 → 退出码，与 Node 原生默认值一致（不改退出码约定）。 */
export function shutdownExitCode(signal: NodeJS.Signals | string): number {
	if (signal === "SIGINT") return 130;
	if (signal === "SIGTERM") return 143;
	if (signal === "SIGHUP") return 129;
	return 1;
}

/**
 * 注册停机收尾动作并返回注销函数。
 *
 * - 第一个钩子注册时自动安装 SIGINT/SIGTERM/SIGHUP 处理器（幂等）；
 * - 同名钩子会替换旧的（模块热重载安全），顺序按首次注册位置；
 * - 执行时按注册逆序（LIFO）启动，彼此并行、共享同一总预算；单个失败只告警，不阻断其余钩子。
 */
export function registerShutdownHook(run: () => unknown, options: { name?: string } = {}): () => void {
	const s = state();
	const name = options.name?.trim() || `hook-${s.hooks.length + 1}`;
	const hook: Hook = { name, run };
	const existing = s.hooks.findIndex((entry) => entry.name === name);
	if (existing >= 0) s.hooks[existing] = hook;
	else s.hooks.push(hook);
	installGracefulShutdown();
	return () => {
		const index = s.hooks.indexOf(hook);
		if (index >= 0) s.hooks.splice(index, 1);
	};
}

/** 已注册钩子名（测试/诊断用，不含具体实现）。 */
export function getRegisteredShutdownHooks(): string[] {
	return state().hooks.map((hook) => hook.name);
}

/**
 * 执行全部停机钩子：并行等待、共享总预算；超时只告警并继续退出流程。
 * 重复调用返回同一个进行中的 Promise（幂等）。
 */
export function runShutdownHooks(reason = "shutdown"): Promise<void> {
	const s = state();
	if (s.running) return s.running;
	const budget = shutdownTimeoutMs();
	s.running = (async () => {
		const hooks = [...s.hooks].reverse();
		if (hooks.length === 0) return;
		const tasks = hooks.map(async (hook) => {
			s.active.add(hook.name);
			try {
				await Promise.resolve().then(hook.run);
			} catch (error) {
				console.warn(`[piweb] 停机收尾「${hook.name}」失败（${reason}）：`, error instanceof Error ? error.message : String(error));
			} finally {
				s.active.delete(hook.name);
			}
		});
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timedOut = await Promise.race([
			Promise.all(tasks).then(() => false),
			new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(true), budget); timer.unref?.(); }),
		]);
		if (timer) clearTimeout(timer);
		if (timedOut) console.warn(`[piweb] 优雅停机超过 ${budget}ms，仍在等待：${[...s.active].join(", ") || "无"}；继续退出。`);
	})().finally(() => {
		// 实际进程随后 exit；清空进行中标记让重复调用/测试可以再次触发（生产里第二次信号会直接退出）。
		s.running = null;
	});
	return s.running;
}

/**
 * 安装信号处理器（幂等）。测试进程（VITEST）默认不接管信号：vitest 结束 worker 时会发
 * SIGTERM，把停机预算当成挂死没有意义；集成测试可显式调用它在子进程里验证。
 */
export function installGracefulShutdown(): void {
	const s = state();
	if (s.installed) return;
	if (process.env.VITEST) return;
	if (process.env.PIWEB_DISABLE_GRACEFUL_SHUTDOWN === "1") return;
	s.installed = true;
	for (const signal of SIGNALS) {
		process.once(signal, () => { void handleSignal(signal); });
	}
}

async function handleSignal(signal: NodeJS.Signals): Promise<void> {
	const s = state();
	s.signals += 1;
	if (s.signals > 1) {
		// 第二次信号：用户不想再等，立即退出（不跑钩子，避免二次收尾互相打架）。
		console.warn(`[piweb] 再次收到 ${signal}，立即退出。`);
		process.exit(shutdownExitCode(signal));
	}
	console.warn(`[piweb] 收到 ${signal}，正在优雅停机（最多 ${shutdownTimeoutMs()}ms）…`);
	try {
		await runShutdownHooks(signal);
	} finally {
		process.exit(shutdownExitCode(signal));
	}
}
