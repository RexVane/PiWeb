/**
 * 启动时检查一次更新：PiWeb 和 pi 各查一次，结果留在内存里给设置页和右下角提示条用，
 * 有新版本时在终端打一行。离线、registry 不通都不吭声——设置里还能手动检查。
 *
 * 状态挂 globalThis：instrumentation 和路由是不同的 bundle，模块级变量不共享（同 remote/supervisor）。
 * 每次服务启动换一个 startId，页面据此做到「每次启动提醒一次」。
 * 手动检查、更新成功后改写这份缓存：刷新页面不会又显示「更新到 vX」。
 * PI_WEB_UPDATE_CHECK=0 关掉启动检查（不联网），设置里手动检查不受影响。
 */
import { randomUUID } from "node:crypto";
import { checkForUpdate, type UpdateCheck, type UpdateTarget } from "../update-service";

/** 一项的结果：检查结果（更新过就带上 updatedTo），或检查失败的原因 */
export type StartupResult = (UpdateCheck & { updatedTo?: string }) | { error: string };

export interface StartupUpdates {
	/** 本次服务启动的标识；关掉启动检查时为 null */
	startId: string | null;
	results: Partial<Record<UpdateTarget, StartupResult>>;
}

interface StartupState {
	startId: string;
	results: Partial<Record<UpdateTarget, StartupResult>>;
	pending: Promise<void> | null;
	started: boolean;
}

interface StartupOptions {
	check?: (target: UpdateTarget) => Promise<UpdateCheck>;
	log?: (line: string) => void;
	env?: Record<string, string | undefined>;
}

const STATE_KEY = "piweb.update.startup";
const TARGETS: readonly UpdateTarget[] = ["piweb", "pi"];
const LABEL: Record<UpdateTarget, string> = { piweb: "PiWeb", pi: "Pi" };

function state(): StartupState {
	const store = globalThis as Record<PropertyKey, unknown>;
	const key = Symbol.for(STATE_KEY);
	const existing = store[key] as StartupState | undefined;
	if (existing) return existing;
	const created: StartupState = { startId: randomUUID(), results: {}, pending: null, started: false };
	store[key] = created;
	return created;
}

export function startupCheckEnabled(env: Record<string, string | undefined> = process.env): boolean {
	return env.PI_WEB_UPDATE_CHECK !== "0";
}

/** 终端里那一行；没有新版本时为 null */
export function updateNoticeLine(results: StartupUpdates["results"]): string | null {
	const parts: string[] = [];
	let manual: string | undefined;
	for (const target of TARGETS) {
		const result = results[target];
		if (!result || "error" in result || !result.canUpdate) continue;
		// Git 检出版本号没变、只是 main 上有新提交时，写提交数而不是「0.3.20 → 0.3.20」
		parts.push(result.latest === result.current && result.behind ? `${LABEL[target]}（main 新增 ${result.behind} 个提交）` : `${LABEL[target]} ${result.current} → ${result.latest}`);
		if (!result.selfUpdate && result.command) manual = result.command;
	}
	if (!parts.length) return null;
	const line = `[更新] 有新版本：${parts.join("、")}。打开 设置 → 通用 点「更新」`;
	return manual ? `${line}；PiWeb 要先停掉 piweb 再运行：${manual}` : line;
}

/**
 * 启动检查（只跑一次）；返回检查完之后的状态快照。关掉时返回 null，不联网。
 * instrumentation 在启动时调它，GET /api/update 也调它（页面先到时由页面触发，结果一样只查一次）。
 */
export async function ensureStartupCheck({ check = checkForUpdate, log = console.log, env = process.env }: StartupOptions = {}): Promise<StartupUpdates | null> {
	if (!startupCheckEnabled(env)) return null;
	const current = state();
	if (!current.started) {
		current.started = true;
		current.pending = (async () => {
			await Promise.all(TARGETS.map(async (target) => {
				try {
					const result = await check(target);
					// 检查期间已经手动更新过的项不覆盖
					if (!current.results[target]) current.results[target] = result;
				} catch (error) {
					if (!current.results[target]) current.results[target] = { error: error instanceof Error ? error.message : String(error) };
				}
			}));
			const line = updateNoticeLine(current.results);
			if (line) log(line);
		})();
	}
	await current.pending;
	return snapshot();
}

function snapshot(): StartupUpdates {
	const current = state();
	return { startId: current.startId, results: { ...current.results } };
}

/** 手动检查的结果覆盖缓存 */
export function recordCheck(target: UpdateTarget, check: UpdateCheck): void {
	state().results[target] = check;
}

/** 更新成功：记下装好的版本，页面刷新后显示「已更新，重启生效」而不是又让人更新一次 */
export function markUpdated(target: UpdateTarget, version: string): void {
	const current = state();
	const previous = current.results[target];
	const base = previous && !("error" in previous) ? previous : { current: "", latest: version, canUpdate: false, selfUpdate: true };
	current.results[target] = { ...base, latest: version || base.latest, canUpdate: false, updatedTo: version || base.latest };
}

/** 仅供测试：清掉挂在 globalThis 上的状态 */
export function resetStartupCheck(): void {
	delete (globalThis as Record<PropertyKey, unknown>)[Symbol.for(STATE_KEY)];
}
