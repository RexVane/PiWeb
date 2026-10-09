"use client";

/**
 * useGrowth：项目生长视图的状态（每轮一个 git commit）。
 * 时间轴（拉取 + 实时 commit 去重合并）、轮次导航 / 默认跟随、范围（本轮 / 本会话累计）、
 * 所选轮的文件与变更、当前磁盘全量目录懒加载、展开状态与新变更动画。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { allDirPaths, buildTree, dirsToReveal, graftLazy, type TreeNode } from "@/lib/growth-tree";
import type { GrowthChange, GrowthRound } from "@/lib/types";

type GrowthScope = "round" | "session";

/** 时间轴上的一项：pi 的一轮（带轮号）或用户在两轮之间自己的修改（n = null） */
export interface GrowthEntry extends GrowthRound {
	/** pi 的第几轮（从 1 起）；「你的修改」为 null */
	n: number | null;
}

interface TreeFile {
	path: string;
	size: number;
}

export interface GrowthApi {
	available: boolean;
	loading: boolean;
	error: string | null;
	/** 本会话的时间轴（时间正序，不含工作区基线） */
	rounds: GrowthEntry[];
	selected: GrowthEntry | null;
	following: boolean;
	scope: GrowthScope;
	/** 所选范围的 from/to tree（查看器取 diff 用） */
	range: { from: string; to: string } | null;
	/** 所选范围的变更 */
	changes: GrowthChange[];
	tree: TreeNode;
	/** 所选轮的全部文件路径（快速打开用） */
	filePaths: string[];
	expanded: Set<string>;
	/** 最新一轮刚改动的路径（入场动画） */
	fresh: Set<string>;
	follow(): void;
	/** 选中某一轮（时间轴柱）；选到最后一轮等于回到跟随 */
	select(commit: string): void;
	prev(): void;
	next(): void;
	setScope(scope: GrowthScope): void;
	toggleDir(path: string): void;
	revealPath(path: string): void;
	expandAll(): void;
	collapseAll(): void;
	expandLazy(path: string): Promise<void>;
	refresh(): Promise<void>;
	/** 立即记录：把当前改动提交为「你的修改」；没改动返回 null */
	recordNow(): Promise<GrowthRound | null>;
}

function sessionIdOf(sessionPath: string): string {
	const bytes = new TextEncoder().encode(sessionPath);
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return encodeURIComponent(btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""));
}

function cwdKey(cwd: string): string {
	const norm = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
	return /^[A-Za-z]:\//.test(norm) || norm.startsWith("//") ? norm.toLowerCase() : norm;
}

/** 拉取结果在前，本次连接收到的实时 commit 按 commit 哈希去重后接在后面 */
function mergeRounds(fetched: GrowthRound[], live: GrowthRound[]): GrowthRound[] {
	if (!live.length) return fetched;
	const known = new Set(fetched.map((round) => round.commit));
	const extra = live.filter((round) => !known.has(round.commit));
	return extra.length ? [...fetched, ...extra] : fetched;
}

/** 去掉工作区基线，给 pi 的轮次编号（「你的修改」不占号） */
export function numberRounds(rounds: GrowthRound[]): GrowthEntry[] {
	let n = 0;
	return rounds.filter((round) => round.kind !== "baseline").map((round) => ({ ...round, n: round.kind === "round" ? (n += 1) : null }));
}

const REVEAL_LIMIT = 200;
const FRESH_MS = 2500;
/** 清单 / 变更缓存条数上限（按 tree 哈希键；长会话几百轮也就几 MB，超过就淘汰最早的） */
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

/** 磁盘列表里永远不画的目录：版本库内部（提交本来就排除它，节点也没有可看的东西） */
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
	liveRounds,
	runtimeError,
	active,
	watchRounds = false,
	connected,
}: {
	cwd: string;
	sessionPath: string | null;
	/** usePiWeb 在本次连接期间收到的实时 commit */
	liveRounds: GrowthRound[];
	/** 实时提交失败；成功提交后由事件清除。 */
	runtimeError?: string | null;
	/** 项目栏或查看器打开：拉磁盘目录、文件清单与范围变更 */
	active: boolean;
	/** 有会话就拉时间轴（对话里「本轮改了 N 个文件」要用），不必等面板打开 */
	watchRounds?: boolean;
	/** SSE 重连后补拉断线期间可能漏掉的 commit。 */
	connected: boolean;
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
	const [fetched, setFetched] = useState<{ key: string; rounds: GrowthRound[]; available: boolean; error: string | null }>({ key: "", rounds: [], available: true, error: null });
	const [loading, setLoading] = useState(false);
	const [selectedCommit, setSelectedCommit] = useState<string | null>(null);
	const [scope, setScopeState] = useState<GrowthScope>("round");
	const [files, setFiles] = useState<{ key: string; tree: string; files: TreeFile[] } | null>(null);
	const [rangeChanges, setRangeChanges] = useState<{ key: string; changes: GrowthChange[]; error?: string } | null>(null);
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
	const lastRevealed = useRef<string>("");
	const previousConnected = useRef(connected);

	useEffect(() => {
		const saved = localStorage.getItem("piweb.growth.scope");
		if (saved === "round" || saved === "session") setScopeState(saved);
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
		setSelectedCommit(null);
		setFresh(new Set());
		setLoading(false);
		setLazyState({ scope: requestScope, children: new Map() });
		if (freshTimer.current) clearTimeout(freshTimer.current);
		lastRevealed.current = "";
	}, [requestScope]);

	const refresh = useCallback(async () => {
		const controller = beginRequest();
		if (!isCurrent(controller)) return;
		requestScope.refresh?.abort();
		requestScope.refresh = controller;
		if (!cwd) {
			setFetched({ key, rounds: [], available: true, error: null });
			updateLazy(controller, () => new Map());
			setLoading(false);
			requestScope.controllers.delete(controller);
			return;
		}
		setLoading(true);
		try {
			const params = new URLSearchParams({ cwd });
			if (sessionPath) params.set("session", sessionPath);
			// 两个请求解耦：磁盘目录先到先画，git 慢（探测超时等）不拖住目录树
			const growthRequest = sessionPath
				? getJson<{ available: boolean; rounds: GrowthRound[] }>(`/api/growth?${params}`, controller.signal).then(
					(value) => ({ status: "fulfilled" as const, value }),
					(reason: unknown) => ({ status: "rejected" as const, reason }),
				)
				: Promise.resolve({ status: "fulfilled" as const, value: { available: true, rounds: [] as GrowthRound[] } });
			// 面板关着时只拉时间轴，不列磁盘
			const diskRequest = active
				? listDiskEntries(cwd, "", controller.signal).then(
					(value) => ({ status: "fulfilled" as const, value }),
					(reason: unknown) => ({ status: "rejected" as const, reason }),
				)
				: Promise.resolve({ status: "skipped" as const });
			void diskRequest.then((diskResult) => {
				if (!isCurrent(controller)) return;
				if (diskResult.status === "fulfilled") {
					updateLazy(controller, (previous) => new Map(previous).set("", diskNodes("", diskResult.value)));
				}
			});
			const growthResult = await growthRequest;
			if (!isCurrent(controller)) return;
			if (growthResult.status === "fulfilled") {
				setFetched({ key, rounds: growthResult.value.rounds ?? [], available: growthResult.value.available !== false, error: null });
			} else {
				setFetched({ key, rounds: [], available: true, error: growthResult.reason instanceof Error ? growthResult.reason.message : "failed to load" });
			}
			const diskResult = await diskRequest;
			if (!isCurrent(controller)) return;
			if (diskResult.status === "rejected" && growthResult.status === "fulfilled") {
				setFetched((previous) => ({ ...previous, error: diskResult.reason instanceof Error ? diskResult.reason.message : "failed to list workspace" }));
			}
		} finally {
			if (isCurrent(controller)) setLoading(false);
			requestScope.controllers.delete(controller);
		}
	}, [cwd, sessionPath, key, active, beginRequest, isCurrent, requestScope, updateLazy]);

	const watching = active || watchRounds;
	useEffect(() => {
		if (watching) void refresh();
		return () => requestScope.refresh?.abort();
	}, [watching, refresh, requestScope]);
	useEffect(() => {
		if (watching && connected && !previousConnected.current) void refresh();
		previousConnected.current = connected;
	}, [watching, connected, refresh]);

	const rounds = useMemo(() => numberRounds(mergeRounds(fetched.key === key ? fetched.rounds : [], liveRounds)), [fetched, key, liveRounds]);
	const latest = rounds[rounds.length - 1] ?? null;
	// 磁盘目录只在提交了新的一轮时重拉，不用每次渲染都重拉一遍全部目录
	const diskPulse = latest?.commit ?? "";
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

	const following = selectedCommit === null;
	const selected = useMemo(
		() => (following ? latest : rounds.find((round) => round.commit === selectedCommit) ?? latest) ?? null,
		[following, latest, rounds, selectedCommit],
	);
	const sessionStart = rounds[0]?.parentTree ?? null;

	// 所选轮的文件清单；缓存身份包含工作区与会话，迟到结果不写缓存。
	useEffect(() => {
		if (!active) return;
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
	}, [active, selected, cwd, key, beginRequest, isCurrent, requestScope]);

	// 所选范围：本轮 = git diff 上一轮 这一轮；本会话累计 = git diff 会话起点 所选这一轮
	const range = useMemo(() => {
		if (!selected) return null;
		if (scope === "round") return { from: selected.parentTree, to: selected.tree };
		return sessionStart ? { from: sessionStart, to: selected.tree } : null;
	}, [selected, scope, sessionStart]);
	// 本轮优先用 commit 自带的变更清单；本会话累计 / 被截断时按 tree 对取
	const inlineChanges = useMemo<GrowthChange[] | null>(() => {
		if (!selected || !range) return [];
		if (range.from === range.to) return [];
		if (scope === "round" && !selected.truncated) return selected.changes;
		return null;
	}, [selected, range, scope]);

	const loadRange = useCallback(
		async (from: string, to: string, controller: AbortController): Promise<GrowthChange[]> => {
			const k = `${key}|${from}..${to}`;
			const cached = changesCache.current.get(k);
			if (cached) return cached;
			const data = await getJson<{ changes: GrowthChange[] }>(`/api/growth?cwd=${encodeURIComponent(cwd)}&from=${from}&to=${to}&changes=1`, controller.signal);
			if (isCurrent(controller)) remember(changesCache.current, k, data.changes);
			return data.changes;
		},
		[cwd, key, isCurrent],
	);

	useEffect(() => {
		if (!active || !range || inlineChanges !== null || !cwd) return;
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
	}, [active, range, inlineChanges, cwd, key, loadRange, beginRequest, isCurrent, requestScope]);

	const changes = useMemo<GrowthChange[]>(() => {
		if (inlineChanges !== null) return inlineChanges;
		if (!range) return [];
		return rangeChanges?.key === `${key}|${range.from}..${range.to}` ? rangeChanges.changes : [];
	}, [inlineChanges, range, rangeChanges, key]);

	const tree = useMemo(() => {
		const base = buildTree(files?.key === key && selected && files.tree === selected.tree ? files.files : [], changes);
		return graftLazy(base, lazyChildren);
	}, [files, selected, changes, lazyChildren, key]);
	const filePaths = useMemo(() => {
		const paths = new Set(files?.key === key && selected && files.tree === selected.tree ? files.files.map((file) => file.path) : []);
		for (const children of lazyChildren.values()) for (const child of children) if (child.kind === "file") paths.add(child.path);
		return [...paths];
	}, [files, selected, lazyChildren, key]);

	// 新的一轮到来（跟随中）：自动展开改动路径上的目录（用户手动收起过的除外）+ 入场动画
	useEffect(() => {
		if (!latest || !following || latest.commit === lastRevealed.current) return;
		const first = lastRevealed.current === "";
		lastRevealed.current = latest.commit;
		// 打开面板时已有的历史不播动画，只对之后新提交的一轮
		if (first && !liveRounds.some((round) => round.commit === latest.commit)) return;
		const list = latest.changes;
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
	}, [latest, following, liveRounds, persistExpanded]);
	useEffect(() => () => {
		if (freshTimer.current) clearTimeout(freshTimer.current);
	}, []);

	// 手动选轮：展开这一轮改动的目录
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
		setSelectedCommit(null);
	}, []);
	const select = useCallback(
		(commit: string) => setSelectedCommit(rounds.length && rounds[rounds.length - 1].commit === commit ? null : commit),
		[rounds],
	);
	const prev = useCallback(() => {
		if (!selected) return;
		const idx = rounds.findIndex((round) => round.commit === selected.commit);
		if (idx > 0) setSelectedCommit(rounds[idx - 1].commit);
	}, [selected, rounds]);
	const next = useCallback(() => {
		if (!selected) return;
		const idx = rounds.findIndex((round) => round.commit === selected.commit);
		if (idx < 0 || idx >= rounds.length - 1) return;
		setSelectedCommit(idx + 1 === rounds.length - 1 ? null : rounds[idx + 1].commit);
	}, [selected, rounds]);

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

	const recordNow = useCallback(async (): Promise<GrowthRound | null> => {
		if (!sessionPath) return null;
		const controller = beginRequest();
		if (!isCurrent(controller)) return null;
		try {
			const r = await fetch("/api/growth", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ action: "record", session: sessionIdOf(sessionPath) }),
				signal: controller.signal,
			});
			const j = await r.json();
			if (!isCurrent(controller)) return null;
			if (!r.ok || !j.success) throw new Error(j.error || `request failed (${r.status})`);
			const round = (j.data?.round ?? null) as GrowthRound | null;
			if (round) setFetched((previous) => isCurrent(controller) && previous.key === key ? { ...previous, rounds: mergeRounds(previous.rounds, [round]) } : previous);
			return round;
		} finally {
			requestScope.controllers.delete(controller);
		}
	}, [sessionPath, key, requestScope, beginRequest, isCurrent]);

	return {
		available: fetched.key === key ? fetched.available : true,
		loading,
		error: runtimeError ?? (fetched.key === key ? fetched.error : null) ?? (range && rangeChanges?.key === `${key}|${range.from}..${range.to}` ? rangeChanges.error : null) ?? null,
		rounds,
		selected,
		following,
		scope,
		range,
		changes,
		tree,
		filePaths,
		expanded,
		fresh,
		follow,
		select,
		prev,
		next,
		setScope,
		toggleDir,
		revealPath,
		expandAll,
		collapseAll,
		expandLazy,
		refresh,
		recordNow,
	};
}
