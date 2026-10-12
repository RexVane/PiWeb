import { useSyncExternalStore } from "react";

/**
 * 更新状态的前端单例：设置里的两行「PiWeb 版本 / Pi 版本」和右下角提示条共用一份，
 * 在一处点了更新，另一处同步显示进度和结果。
 *
 * 页面打开时取一次启动检查的结果（GET /api/update，服务启动时已经在查），
 * 不用先点「检查更新」就知道有没有新版本。
 */

export type UpdateTarget = "piweb" | "pi";
export type UpdatePhase = "idle" | "checking" | "available" | "updating" | "latest" | "updated" | "error";

export interface TargetUpdate {
	phase: UpdatePhase;
	current: string;
	latest: string;
	/** Git 检出：main 上落后的提交数（版本号没变时用它说明「有新提交」） */
	behind: number;
	/** 要用户自己执行的命令（Windows 上的 npm 安装 PiWeb 不能替换运行中的自己）；空串表示能直接更新 */
	command: string;
	error: string;
	/** 失败是因为有会话正在运行（409） */
	busy: boolean;
}

export interface UpdateState {
	/** 启动检查的结果取回来了（成功或失败都算） */
	loaded: boolean;
	/** 本次服务启动的标识，提示条按它做到「每次启动提醒一次」；关掉启动检查时为 null */
	startId: string | null;
	targets: Record<UpdateTarget, TargetUpdate>;
}

export const UPDATE_TARGETS: readonly UpdateTarget[] = ["piweb", "pi"];

interface CheckData {
	current: string;
	latest: string;
	canUpdate: boolean;
	behind?: number;
	command?: string;
	updatedTo?: string;
}

const blank = (): TargetUpdate => ({ phase: "idle", current: "", latest: "", behind: 0, command: "", error: "", busy: false });
const initial = (): UpdateState => ({ loaded: false, startId: null, targets: { piweb: blank(), pi: blank() } });

let state: UpdateState = initial();
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function emit(): void {
	for (const listener of listeners) listener();
}

function patch(target: UpdateTarget, next: Partial<TargetUpdate>): void {
	state = { ...state, targets: { ...state.targets, [target]: { ...state.targets[target], ...next } } };
	emit();
}

function fromCheck(check: CheckData): Partial<TargetUpdate> {
	const base = { current: check.current, behind: check.behind ?? 0, error: "", busy: false };
	if (check.updatedTo) return { ...base, phase: "updated", latest: check.updatedTo, command: "" };
	if (check.canUpdate) return { ...base, phase: "available", latest: check.latest, command: check.command ?? "" };
	return { ...base, phase: "latest", latest: check.latest, command: "" };
}

class UpdateRequestError extends Error {
	busy: boolean;
	constructor(message: string, busy: boolean) {
		super(message);
		this.busy = busy;
	}
}

async function post(target: UpdateTarget, action: "check" | "update") {
	const response = await fetch("/api/update", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ target, action }),
	});
	const json = await response.json();
	if (!json.success) throw new UpdateRequestError(String(json.error ?? response.status), response.status === 409);
	return json.data;
}

function failure(error: unknown): Partial<TargetUpdate> {
	return { phase: "error", error: error instanceof Error ? error.message : String(error), busy: error instanceof UpdateRequestError && error.busy };
}

/** 取启动检查的结果；每个页面只取一次（设置面板反复开关不重复请求） */
export function loadUpdates(): Promise<void> {
	loading ??= (async () => {
		try {
			const response = await fetch("/api/update", { cache: "no-store" });
			const json = await response.json();
			if (!json.success) throw new Error(String(json.error));
			const targets = { ...state.targets };
			for (const target of UPDATE_TARGETS) {
				const result = json.data?.results?.[target];
				// 已经手动查过 / 正在更新的不覆盖；启动检查失败的项留在 idle，照旧手动检查
				if (targets[target].phase !== "idle" || !result || "error" in result) continue;
				targets[target] = { ...targets[target], ...fromCheck(result) };
			}
			state = { loaded: true, startId: json.data?.startId ?? null, targets };
		} catch {
			state = { ...state, loaded: true };
		}
		emit();
	})();
	return loading;
}

export async function checkUpdate(target: UpdateTarget): Promise<void> {
	patch(target, { phase: "checking", error: "", busy: false });
	try {
		patch(target, fromCheck(await post(target, "check")));
	} catch (error) {
		patch(target, failure(error));
	}
}

/** 更新一项；成功返回 true。装好后要用户手动重启，进程不自己重启 */
export async function runUpdate(target: UpdateTarget): Promise<boolean> {
	patch(target, { phase: "updating", error: "", busy: false });
	try {
		const data = await post(target, "update");
		patch(target, { phase: "updated", latest: data?.version || state.targets[target].latest, command: "" });
		return true;
	} catch (error) {
		patch(target, failure(error));
		return false;
	}
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

const getState = () => state;

export function useUpdates(): UpdateState {
	return useSyncExternalStore(subscribe, getState, getState);
}

/** 仅供测试：回到页面刚打开时的状态 */
export function resetUpdates(): void {
	state = initial();
	loading = null;
	emit();
}
