"use client";

/**
 * @ 引用的候选文件：打开候选菜单时拉一次全量清单，之后每个字符都在本地匹配。
 * 按工作区缓存（含 in-flight 去重），过期后**先用手上的旧清单渲染、再后台刷新**——
 * 打字过程中绝不能因为一次刷新把候选列表清空。
 */
import { useEffect, useRef, useState } from "react";
import { buildCandidates, dirsOfPaths, type PathCandidate } from "@/lib/workspace-index";

export interface WorkspaceFiles {
	status: "idle" | "loading" | "ready" | "error";
	candidates: PathCandidate[];
	source: "git" | "disk" | null;
	truncated: boolean;
	error: string | null;
}

/** 清单多久算过期：agent 刚写出来的新文件也要能被引用到，所以不能一直用内存里那份 */
const TTL_MS = 30_000;

interface CachedIndex {
	at: number;
	candidates: PathCandidate[];
	source: "git" | "disk";
	truncated: boolean;
}

const cache = new Map<string, CachedIndex>();
const inflight = new Map<string, Promise<CachedIndex>>();

async function fetchIndex(cwd: string): Promise<CachedIndex> {
	const response = await fetch(`/api/files?index=1&cwd=${encodeURIComponent(cwd)}`, { cache: "no-store" });
	const payload = await response.json();
	if (!response.ok || !payload.success) throw new Error(payload.error || `request failed (${response.status})`);
	const data = payload.data as { files: string[]; source: "git" | "disk"; truncated: boolean };
	const entry: CachedIndex = {
		at: Date.now(),
		candidates: buildCandidates(data.files, dirsOfPaths(data.files)),
		source: data.source,
		truncated: data.truncated,
	};
	cache.set(cwd, entry);
	return entry;
}

/**
 * 同一工作区并发只发一次请求；失败不进缓存（下次打开会重试）。
 * 共享的请求不挂任何一方的 AbortSignal：先打开的输入框关了（中止），后来的还在等同一个结果，
 * 不能让它跟着收到 AbortError。各方用完就不理结果，请求本身让它跑完、顺手填进缓存。
 */
function loadIndex(cwd: string): Promise<CachedIndex> {
	const running = inflight.get(cwd);
	if (running) return running;
	const promise = fetchIndex(cwd).finally(() => inflight.delete(cwd));
	inflight.set(cwd, promise);
	return promise;
}

export function useWorkspaceFiles(cwd: string, enabled: boolean): WorkspaceFiles {
	const [state, setState] = useState<WorkspaceFiles>({ status: "idle", candidates: [], source: null, truncated: false, error: null });
	const scope = useRef<{ cwd: string; controller: AbortController }>({ cwd: "", controller: new AbortController() });

	useEffect(() => {
		if (!enabled || !cwd) return;
		const controller = new AbortController();
		scope.current = { cwd, controller };
		const isCurrent = () => scope.current.controller === controller && !controller.signal.aborted;

		const cached = cache.get(cwd);
		if (cached) {
			// 有旧清单就先显示（旧的总比空白好），过期只在后台补
			setState({ status: "ready", candidates: cached.candidates, source: cached.source, truncated: cached.truncated, error: null });
			if (Date.now() - cached.at < TTL_MS) return () => controller.abort();
		} else {
			setState({ status: "loading", candidates: [], source: null, truncated: false, error: null });
		}

		void loadIndex(cwd).then(
			(entry) => {
				if (isCurrent()) setState({ status: "ready", candidates: entry.candidates, source: entry.source, truncated: entry.truncated, error: null });
			},
			(error: unknown) => {
				// 有旧清单时忽略这次失败：刷新失败不该把可用候选变成错误页
				if (!isCurrent() || cache.has(cwd)) return;
				setState({ status: "error", candidates: [], source: null, truncated: false, error: error instanceof Error ? error.message : String(error) });
			},
		);
		return () => controller.abort();
	}, [cwd, enabled]);

	return state;
}
