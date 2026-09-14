"use client";

/**
 * useGrowth：项目生长视图的状态。
 * 账本（拉取 + 实时步按 seq 合并）、轮次导航 / 默认跟随、范围（本步 / 本会话）、
 * 所选快照的文件与变更、当前磁盘全量目录懒加载、展开状态与新变更动画。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { allDirPaths, buildTree, dirsToReveal, graftLazy, type TreeNode } from "@/lib/growth-tree";
import { buildGrowthRounds, type GrowthRound } from "@/lib/growth-rounds";
import type { GrowthChange, GrowthStep } from "@/lib/types";

export type GrowthScope = "step" | "session";

export interface TreeFile {
	path: string;
	size: number;
}

export interface GrowthApi {
	available: boolean;
	loading: boolean;
	error: string | null;
	steps: GrowthStep[];
	rounds: GrowthRound[];
	/** 本会话第一步（基线） */
	baseline: GrowthStep | null;
	latest: GrowthStep | null;
	selected: GrowthStep | null;
	selectedRound: GrowthRound | null;
	following: boolean;
	scope: GrowthScope;
	/** 所选范围的 from/to tree（查看器取 diff 用） */
	range: { from: string; to: string } | null;
	changes: GrowthChange[];
	/** 相对会话基线的全部变更（头部总计） */
	sessionChanges: GrowthChange[];
	tree: TreeNode;
	/** 所选步的全部文件路径（快速打开用） */
	filePaths: string[];
	expanded: Set<string>;
	/** 最新一步刚改动的路径（入场动画） */
	fresh: Set<string>;
	pending: string[];
	follow(): void;
	/** 选中某一轮（时间轴柱）；选到最后一轮等于回到跟随 */
	selectRound(id: number): void;
	prev(): void;
	next(): void;
	setScope(scope: GrowthScope): void;
	toggleDir(path: string): void;
	revealPath(path: string): void;
	expandAll(): void;
	collapseAll(): void;
	expandLazy(path: string): Promise<void>;
	refresh(): Promise<void>;
	snapshotNow(): Promise<GrowthStep | null>;
}

export function sessionIdOf(sessionPath: string): string {
	const bytes = new TextEncoder().encode(sessionPath);
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return encodeURIComponent(btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""));
}

function cwdKey(cwd: string): string {
	const norm = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
	return /^[A-Za-z]:\//.test(norm) || norm.startsWith("//") ? norm.toLowerCase() : norm;
}

function mergeSteps(fetched: GrowthStep[], live: GrowthStep[]): GrowthStep[] {
	if (!live.length) return fetched;
	const bySeq = new Map<number, GrowthStep>();
	for (const s of fetched) bySeq.set(s.seq, s);
	for (const s of live) bySeq.set(s.seq, s);
	return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

const REVEAL_LIMIT = 200;
const FRESH_MS = 2500;
/** 非跟随态给出的稳定空数组：每次渲染都 new 一个会让下游 effect（查看器取数）反复重跑 */
const NO_PENDING: string[] = [];
/** 清单 / 变更缓存条数上限（按 tree 哈希键；长会话几百步也就几 MB，超过就淘汰最早的） */
const CACHE_LIMIT = 300;
function remember<K, V>(map: Map<K, V>, key: K, value: V): void {
	if (map.size >= CACHE_LIMIT) map.delete(map.keys().next().value as K);
	map.set(key, value);
}

interface DiskEntry {
	name: string;
	kind: "dir" | "file";
	size?: number;
}

/** 磁盘列表里永远不画的目录：版本库内部（快照本来就排除它，节点也没有可看的东西） */
const HIDDEN_DISK_DIRS = new Set([".git"]);

function diskNodes(parent: string, entries: DiskEntry[]): TreeNode[] {
	return entries.filter((entry) => !(entry.kind === "dir" && !parent && HIDDEN_DISK_DIRS.has(entry.name))).map((entry) => ({
		path: parent ? `${parent}/${entry.name}` : entry.name,
		name: entry.name,
		kind: entry.kind,
		size: entry.size,
		lazy: true,
		...(entry.kind === "dir" ? { children: [] } : {}),
	}));
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
	signal?.throwIfAborted();
	const r = await fetch(url, { signal, cache: "no-store" });
	const j = await r.json();
	signal?.throwIfAborted();
	if (!r.ok || !j.success) throw new Error(j.error || `request failed (${r.status})`);
	return j.data as T;
}

async function listDiskEntries(cwd: string, dir: string, signal: AbortSignal): Promise<DiskEntry[]> {
	const entries: DiskEntry[] = [];
	let offset = 0;
	for (;;) {
		const query = new URLSearchParams({ cwd, path: dir, offset: String(offset) });
		const page = await getJson<{ entries: DiskEntry[]; nextOffset: number | null }>(`/api/files?${query}`, signal);
		entries.push(...page.entries);
		if (page.nextOffset === null) return entries;
		if (page.nextOffset <= offset) throw new Error("directory pagination did not advance");
		offset = page.nextOffset;
	}
}

export function useGrowth({
	cwd,
	sessionPath,
	liveSteps,
	pending,
	runtimeError,
	active,
	connected,
	turnStarts = [],
}: {
	cwd: string;
	sessionPath: string | null;
	/** usePiWeb 在本次连接期间收到的实时步 */
	liveSteps: GrowthStep[];
	/** 改盘类工具运行期间目录监听看到的路径 */
	pending: string[];
	/** 实时快照失败；成功记录后由事件清除。 */
	runtimeError?: string | null;
	/** 项目栏或查看器打开时才拉数据 */
	active: boolean;
	/** SSE 重连后补拉断线期间可能漏掉的生长步。 */
	connected: boolean;
	/** 用户消息的时间戳；用于在旧快照缺少回合标记时恢复轮次边界。 */
	turnStarts?: number[];
}): GrowthApi {
	const key = JSON.stringify([cwdKey(cwd), sessionPath ?? ""]);
	const requestScope = useMemo(() => ({
		key,
		active: true,
		controllers: new Set<AbortController>(),
		loadingDirs: new Map<string, AbortController>(),
		refresh: null as AbortController | null,
	}), [key]);
	const currentScope = useRef(requestScope);
	currentScope.current = requestScope;
	const beginRequest = useCallback(() => {
		const controller = new AbortController();
		if (currentScope.current !== requestScope || !requestScope.active) controller.abort();
		else requestScope.controllers.add(controller);
		return controller;
	}, [requestScope]);
	const isCurrent = useCallback((controller: AbortController) => currentScope.current === requestScope && requestScope.active && !controller.signal.aborted, [requestScope]);
	useEffect(() => {
		requestScope.active = true;
		return () => {
			requestScope.active = false;
			for (const controller of requestScope.controllers) controller.abort();
			requestScope.controllers.clear();
			requestScope.loadingDirs.clear();
		};
	}, [requestScope]);
	const [fetched, setFetched] = useState<{ key: string; steps: GrowthStep[]; available: boolean; error: string | null }>({ key: "", steps: [], available: true, error: null });
	const [loading, setLoading] = useState(false);
	const [selectedRoundId, setSelectedRoundId] = useState<number | null>(null);
	const [scope, setScopeState] = useState<GrowthScope>("step");
	const [files, setFiles] = useState<{ key: string; tree: string; files: TreeFile[] } | null>(null);
	const [rangeChanges, setRangeChanges] = useState<{ key: string; changes: GrowthChange[]; error?: string } | null>(null);
	const [sessionRange, setSessionRange] = useState<{ key: string; changes: GrowthChange[]; error?: string } | null>(null);
	const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
	const [fresh, setFresh] = useState<Set<string>>(() => new Set());
	const [lazyState, setLazyState] = useState(() => ({ scope: requestScope, children: new Map<string, TreeNode[]>() }));
	const lazyChildren = useMemo(() => lazyState.scope === requestScope ? lazyState.children : new Map<string, TreeNode[]>(), [lazyState, requestScope]);
	const lazyChildrenRef = useRef(lazyChildren);
	lazyChildrenRef.current = lazyChildren;
	const updateLazy = useCallback((controller: AbortController, update: (previous: Map<string, TreeNode[]>) => Map<string, TreeNode[]>) => {
		if (!isCurrent(controller)) return;
		setLazyState((previous) => isCurrent(controller)
			? { scope: requestScope, children: update(previous.scope === requestScope ? previous.children : new Map()) }
			: previous);
	}, [isCurrent, requestScope]);
	const listingCache = useRef(new Map<string, TreeFile[]>());
	const changesCache = useRef(new Map<string, GrowthChange[]>());
	const collapsedByUser = useRef(new Set<string>());
	const freshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const lastRevealedSeq = useRef<number>(0);
	const previousConnected = useRef(connected);

	useEffect(() => {
		const saved = localStorage.getItem("piweb.growth.scope");
		if (saved === "step" || saved === "session") setScopeState(saved);
	}, []);
	const setScope = useCallback((s: GrowthScope) => {
		setScopeState(s);
		localStorage.setItem("piweb.growth.scope", s);
	}, []);

	// 展开集合按工作区持久化
	useEffect(() => {
		if (!cwd) return;
		try {
			const raw = localStorage.getItem(`piweb.growth.expanded:${cwdKey(cwd)}`);
			setExpanded(new Set(raw ? (JSON.parse(raw) as string[]) : []));
		} catch {
			setExpanded(new Set());
		}
		collapsedByUser.current = new Set();
	}, [cwd]);
	const persistExpanded = useCallback(
		(next: Set<string>) => {
			if (!cwd) return;
			try {
				localStorage.setItem(`piweb.growth.expanded:${cwdKey(cwd)}`, JSON.stringify([...next].slice(0, 2000)));
			} catch {
				/* ignore */
			}
		},
		[cwd],
	);

	// 切会话：回到跟随、清实时相关状态
	useEffect(() => {
		setSelectedRoundId(null);
		setFresh(new Set());
		setLoading(false);
		setLazyState({ scope: requestScope, children: new Map() });
		if (freshTimer.current) clearTimeout(freshTimer.current);
		lastRevealedSeq.current = 0;
	}, [requestScope]);

	const refresh = useCallback(async () => {
		const controller = beginRequest();
		if (!isCurrent(controller)) return;
		requestScope.refresh?.abort();
		requestScope.refresh = controller;
		if (!cwd) {
			setFetched({ key, steps: [], available: true, error: null });
			updateLazy(controller, () => new Map());
			setLoading(false);
			requestScope.controllers.delete(controller);
			return;
		}
		setLoading(true);
		try {
			const params = new URLSearchParams({ cwd });
			if (sessionPath) params.set("session", sessionPath);
			const [growthResult, diskResult] = await Promise.allSettled([
				sessionPath ? getJson<{ available: boolean; steps: GrowthStep[] }>(`/api/growth?${params}`, controller.signal) : Promise.resolve({ available: true, steps: [] }),
				listDiskEntries(cwd, "", controller.signal),
			]);
			if (!isCurrent(controller)) return;
			if (growthResult.status === "fulfilled") {
				setFetched({ key, steps: growthResult.value.steps ?? [], available: growthResult.value.available !== false, error: null });
			} else {
				setFetched({ key, steps: [], available: true, error: growthResult.reason instanceof Error ? growthResult.reason.message : "failed to load" });
			}
			if (diskResult.status === "fulfilled") {
				updateLazy(controller, (previous) => new Map(previous).set("", diskNodes("", diskResult.value)));
			} else if (growthResult.status === "fulfilled") {
				setFetched((previous) => ({ ...previous, error: diskResult.reason instanceof Error ? diskResult.reason.message : "failed to list workspace" }));
			}
		} finally {
			if (isCurrent(controller)) setLoading(false);
			requestScope.controllers.delete(controller);
		}
	}, [cwd, sessionPath, key, beginRequest, isCurrent, requestScope, updateLazy]);

	useEffect(() => {
		if (active) void refresh();
		return () => requestScope.refresh?.abort();
	}, [active, refresh, requestScope]);
	useEffect(() => {
		if (active && connected && !previousConnected.current) void refresh();
		previousConnected.current = connected;
	}, [active, connected, refresh]);

	const steps = useMemo(() => mergeSteps(fetched.key === key ? fetched.steps : [], liveSteps), [fetched, key, liveSteps]);
	const baseline = steps[0] ?? null;
	const latest = steps[steps.length - 1] ?? null;
	// 磁盘目录只在记下新步时重拉：工具运行中的新路径由目录监听直接画成「生成中」节点，不用每 300ms 重拉一遍全部目录
	const diskPulse = latest?.seq ?? 0;
	useEffect(() => {
		if (!active || !cwd || !latest) return;
		const controller = beginRequest();
		const timer = setTimeout(() => {
			if (!isCurrent(controller)) return;
			const dirs = [...new Set(["", ...lazyChildrenRef.current.keys()])];
			void Promise.allSettled(dirs.map((dir) => listDiskEntries(cwd, dir, controller.signal)))
				.then((results) => {
					updateLazy(controller, (previous) => {
						const next = new Map(previous);
						for (const [index, result] of results.entries()) {
							if (result.status === "fulfilled") next.set(dirs[index], diskNodes(dirs[index], result.value));
							else if (dirs[index]) next.delete(dirs[index]);
						}
						return next;
					});
				}).finally(() => requestScope.controllers.delete(controller));
		}, 100);
		return () => {
			controller.abort();
			requestScope.controllers.delete(controller);
			clearTimeout(timer);
		};
	}, [active, cwd, diskPulse, beginRequest, isCurrent, requestScope, updateLazy]);
	const rounds = useMemo(() => buildGrowthRounds(steps, turnStarts), [steps, turnStarts]);
	const following = selectedRoundId === null;
	const selectedRound = useMemo(
		() => (following ? rounds[rounds.length - 1] : rounds.find((round) => round.id === selectedRoundId) ?? rounds[rounds.length - 1]) ?? null,
		[following, rounds, selectedRoundId],
	);
	const selected = selectedRound ? selectedRound.last : baseline;

	// 所选步的文件清单；缓存身份包含工作区与会话，迟到结果不写缓存。
	useEffect(() => {
		if (!selected || !cwd) {
			setFiles(null);
			return;
		}
		const tree = selected.tree;
		const cacheKey = `${key}|${tree}`;
		const cached = listingCache.current.get(cacheKey);
		if (cached) {
			setFiles({ key, tree, files: cached });
			return;
		}
		const controller = beginRequest();
		void getJson<{ files: TreeFile[] }>(`/api/growth?cwd=${encodeURIComponent(cwd)}&tree=${tree}&list=1`, controller.signal)
			.then((data) => {
				if (!isCurrent(controller)) return;
				remember(listingCache.current, cacheKey, data.files);
				setFiles({ key, tree, files: data.files });
			})
			.catch(() => {
				if (isCurrent(controller)) setFiles({ key, tree, files: [] });
			})
			.finally(() => requestScope.controllers.delete(controller));
		return () => {
			controller.abort();
			requestScope.controllers.delete(controller);
		};
	}, [selected, cwd, key, beginRequest, isCurrent, requestScope]);

	// 所选范围的变更：本步优先用账本内嵌清单；本会话 / 截断时按 tree 对取
	const range = useMemo(() => {
		if (!selected || (selectedRound && !selectedRound.recorded)) return null;
		if (scope === "step") return selectedRound?.fromTree && selectedRound.toTree ? { from: selectedRound.fromTree, to: selectedRound.toTree } : null;
		return { from: (baseline ?? selected).tree, to: selected.tree };
	}, [selected, selectedRound, scope, baseline]);
	const inlineChanges = useMemo<GrowthChange[] | null>(() => {
		if (!selected || !selectedRound || !selectedRound.recorded) return [];
		if (scope === "step") return selectedRound.steps.length === 1 && selectedRound.fromTree === selected.parent && !selected.truncated ? selected.changes : null;
		if (baseline && baseline.seq === selected.seq) return [];
		return null;
	}, [selected, selectedRound, scope, baseline]);

	const loadRange = useCallback(
		async (from: string, to: string, controller: AbortController): Promise<GrowthChange[]> => {
			const k = `${key}|${from}..${to}`;
			const cached = changesCache.current.get(k);
			if (cached) return cached;
			if (from === to) return [];
			const data = await getJson<{ changes: GrowthChange[] }>(`/api/growth?cwd=${encodeURIComponent(cwd)}&from=${from}&to=${to}&changes=1`, controller.signal);
			if (isCurrent(controller)) remember(changesCache.current, k, data.changes);
			return data.changes;
		},
		[cwd, key, isCurrent],
	);

	useEffect(() => {
		if (!range || inlineChanges !== null || !cwd) return;
		const k = `${key}|${range.from}..${range.to}`;
		const controller = beginRequest();
		void loadRange(range.from, range.to, controller)
			.then((changes) => {
				if (isCurrent(controller)) setRangeChanges({ key: k, changes });
			})
			.catch((error) => {
				if (isCurrent(controller)) setRangeChanges({ key: k, changes: [], error: error instanceof Error ? error.message : "failed to load round changes" });
			})
			.finally(() => requestScope.controllers.delete(controller));
		return () => {
			controller.abort();
			requestScope.controllers.delete(controller);
		};
	}, [range, inlineChanges, cwd, key, loadRange, beginRequest, isCurrent, requestScope]);

	const changes = useMemo<GrowthChange[]>(() => {
		if (inlineChanges !== null) return inlineChanges;
		if (!range) return [];
		return rangeChanges?.key === `${key}|${range.from}..${range.to}` ? rangeChanges.changes : [];
	}, [inlineChanges, range, rangeChanges, key]);

	// 本会话总计（基线 → 所选步）
	useEffect(() => {
		if (!baseline || !selected || !cwd) return;
		const k = `${key}|${baseline.tree}..${selected.tree}`;
		const controller = beginRequest();
		void loadRange(baseline.tree, selected.tree, controller)
			.then((list) => {
				if (isCurrent(controller)) setSessionRange({ key: k, changes: list });
			})
			.catch((error) => {
				if (isCurrent(controller)) setSessionRange({ key: k, changes: [], error: error instanceof Error ? error.message : "failed to load session changes" });
			})
			.finally(() => requestScope.controllers.delete(controller));
		return () => {
			controller.abort();
			requestScope.controllers.delete(controller);
		};
	}, [baseline, selected, cwd, key, loadRange, beginRequest, isCurrent, requestScope]);
	const sessionChanges = useMemo(() => (baseline && selected && sessionRange?.key === `${key}|${baseline.tree}..${selected.tree}` ? sessionRange.changes : []), [baseline, selected, sessionRange, key]);

	const shownPending = following ? pending : NO_PENDING;
	const tree = useMemo(() => {
		const base = buildTree(files?.key === key && selected && files.tree === selected.tree ? files.files : [], changes, shownPending);
		return graftLazy(base, lazyChildren);
	}, [files, selected, changes, shownPending, lazyChildren, key]);
	const filePaths = useMemo(() => {
		const paths = new Set(files?.key === key && selected && files.tree === selected.tree ? files.files.map((file) => file.path) : []);
		for (const children of lazyChildren.values()) for (const child of children) if (child.kind === "file") paths.add(child.path);
		return [...paths];
	}, [files, selected, lazyChildren, key]);

	// 新步到来（跟随中）：自动展开改动路径上的目录（用户手动收起过的除外）+ 入场动画
	useEffect(() => {
		if (!latest || !following || latest.seq === lastRevealedSeq.current) return;
		lastRevealedSeq.current = latest.seq;
		const list = latest.initial ? [] : latest.changes;
		if (!list.length) return;
		const dirs = dirsToReveal(list.slice(0, REVEAL_LIMIT)).filter((d) => !collapsedByUser.current.has(d));
		if (dirs.length) {
			setExpanded((prev) => {
				const next = new Set(prev);
				for (const d of dirs) next.add(d);
				persistExpanded(next);
				return next;
			});
		}
		setFresh(new Set(list.map((c) => c.path)));
		if (freshTimer.current) clearTimeout(freshTimer.current);
		freshTimer.current = setTimeout(() => setFresh(new Set()), FRESH_MS);
	}, [latest, following, persistExpanded]);
	useEffect(() => () => {
		if (freshTimer.current) clearTimeout(freshTimer.current);
	}, []);

	// 生成中的路径也把目录撑开
	useEffect(() => {
		if (!shownPending.length) return;
		const dirs = dirsToReveal([], shownPending.slice(0, REVEAL_LIMIT)).filter((d) => !collapsedByUser.current.has(d));
		if (!dirs.length) return;
		setExpanded((prev) => {
			if (dirs.every((d) => prev.has(d))) return prev;
			const next = new Set(prev);
			for (const d of dirs) next.add(d);
			return next;
		});
	}, [shownPending]);

	// 手动选步：展开这一步改动的目录
	useEffect(() => {
		if (following || !selected) return;
		const list = changes.slice(0, REVEAL_LIMIT);
		if (!list.length) return;
		const dirs = dirsToReveal(list);
		setExpanded((prev) => {
			if (dirs.every((d) => prev.has(d))) return prev;
			const next = new Set(prev);
			for (const d of dirs) next.add(d);
			return next;
		});
	}, [following, selected, changes]);

	const follow = useCallback(() => {
		setSelectedRoundId(null);
	}, []);
	const selectRound = useCallback(
		(id: number) => setSelectedRoundId(rounds.length && rounds[rounds.length - 1].id === id ? null : id),
		[rounds],
	);
	const prev = useCallback(() => {
		if (!selectedRound) return;
		const idx = rounds.findIndex((round) => round.id === selectedRound.id);
		if (idx > 0) setSelectedRoundId(rounds[idx - 1].id);
	}, [selectedRound, rounds]);
	const next = useCallback(() => {
		if (!selectedRound) return;
		const idx = rounds.findIndex((round) => round.id === selectedRound.id);
		if (idx < 0 || idx >= rounds.length - 1) return;
		setSelectedRoundId(idx + 1 === rounds.length - 1 ? null : rounds[idx + 1].id);
	}, [selectedRound, rounds]);

	const toggleDir = useCallback(
		(path: string) => {
			setExpanded((prevSet) => {
				const nextSet = new Set(prevSet);
				if (nextSet.has(path)) {
					nextSet.delete(path);
					collapsedByUser.current.add(path);
				} else {
					nextSet.add(path);
					collapsedByUser.current.delete(path);
				}
				persistExpanded(nextSet);
				return nextSet;
			});
		},
		[persistExpanded],
	);
	const revealPath = useCallback(
		(path: string) => {
			const parts = path.split("/");
			const dirs: string[] = [];
			for (let i = 1; i < parts.length; i += 1) dirs.push(parts.slice(0, i).join("/"));
			setExpanded((prevSet) => {
				const nextSet = new Set(prevSet);
				for (const d of dirs) {
					nextSet.add(d);
					collapsedByUser.current.delete(d);
				}
				persistExpanded(nextSet);
				return nextSet;
			});
		},
		[persistExpanded],
	);
	const expandAll = useCallback(() => {
		const all = new Set(allDirPaths(tree));
		collapsedByUser.current = new Set();
		setExpanded(all);
		persistExpanded(all);
	}, [tree, persistExpanded]);
	const collapseAll = useCallback(() => {
		const empty = new Set<string>();
		setExpanded(empty);
		persistExpanded(empty);
	}, [persistExpanded]);

	const expandLazy = useCallback(
		async (path: string) => {
			if (!cwd || currentScope.current !== requestScope || lazyChildrenRef.current.has(path) || requestScope.loadingDirs.has(path)) return;
			const controller = beginRequest();
			if (!isCurrent(controller)) return;
			requestScope.loadingDirs.set(path, controller);
			try {
				const entries = await listDiskEntries(cwd, path, controller.signal);
				updateLazy(controller, (previous) => new Map(previous).set(path, diskNodes(path, entries)));
			} catch {
				// 不把失败缓存为空目录：重试或另一个工作区必须能发出真正的请求。
			} finally {
				if (requestScope.loadingDirs.get(path) === controller) requestScope.loadingDirs.delete(path);
				requestScope.controllers.delete(controller);
			}
		},
		[cwd, requestScope, beginRequest, isCurrent, updateLazy],
	);

	const snapshotNow = useCallback(async (): Promise<GrowthStep | null> => {
		if (!sessionPath) return null;
		const controller = beginRequest();
		if (!isCurrent(controller)) return null;
		try {
			const r = await fetch("/api/growth", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ action: "snapshot", session: sessionIdOf(sessionPath) }),
				signal: controller.signal,
			});
			const j = await r.json();
			if (!isCurrent(controller)) return null;
			if (!r.ok || !j.success) throw new Error(j.error || `request failed (${r.status})`);
			const step = (j.data?.step ?? null) as GrowthStep | null;
			if (step) setFetched((previous) => isCurrent(controller) && previous.key === key ? { ...previous, steps: mergeSteps(previous.steps, [step]) } : previous);
			return step;
		} finally {
			requestScope.controllers.delete(controller);
		}
	}, [sessionPath, key, requestScope, beginRequest, isCurrent]);

	return {
		available: fetched.key === key ? fetched.available : true,
		loading,
		error: runtimeError ?? (fetched.key === key ? fetched.error : null) ?? (range && rangeChanges?.key === `${key}|${range.from}..${range.to}` ? rangeChanges.error : null) ?? (baseline && selected && sessionRange?.key === `${key}|${baseline.tree}..${selected.tree}` ? sessionRange.error : null) ?? null,
		steps,
		rounds,
		baseline,
		latest,
		selected,
		selectedRound,
		following,
		scope,
		range,
		changes,
		sessionChanges,
		tree,
		filePaths,
		expanded,
		fresh,
		pending: shownPending,
		follow,
		selectRound,
		prev,
		next,
		setScope,
		toggleDir,
		revealPath,
		expandAll,
		collapseAll,
		expandLazy,
		refresh,
		snapshotNow,
	};
}
