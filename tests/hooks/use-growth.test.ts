// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { numberRounds, useGrowth } from "../../src/hooks/useGrowth";
import type { GrowthChange, GrowthRound } from "../../src/lib/types";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}

function response(data: unknown): Response {
	return { ok: true, status: 200, json: async () => ({ success: true, data }) } as Response;
}

function directory(name: string): Response {
	return response({ entries: [{ name, kind: "file", size: 1 }], nextOffset: null });
}

const h = (c: string) => c.repeat(40);
function round(commit: string, parentTree: string, tree: string, extra: Partial<GrowthRound> = {}): GrowthRound {
	const changes = extra.changes ?? [];
	return {
		commit: h(commit), parent: null, tree: h(tree), parentTree: h(parentTree), ts: 1, kind: "round", title: "", session: "s.jsonl",
		promptIds: [], status: "done", changes,
		stats: { added: changes.filter((c) => c.status === "A").length, modified: changes.filter((c) => c.status === "M").length, deleted: 0, renamed: 0, add: 1, del: 0 },
		...extra,
	};
}

const noRounds: GrowthRound[] = [];
const initialProps = { cwd: "/workspace-a", sessionPath: "/session-a.jsonl", liveRounds: noRounds, active: false, connected: true };

beforeEach(() => { localStorage.clear(); });
afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("numberRounds", () => {
	it("hides the workspace baseline and numbers only pi's rounds", () => {
		const list = numberRounds([
			round("a", "0", "1", { kind: "baseline" }),
			round("b", "1", "2"),
			round("c", "2", "3", { kind: "user" }),
			round("d", "3", "3"),
		]);
		expect(list.map((r) => [r.commit[0], r.n])).toEqual([["b", 1], ["c", null], ["d", 2]]);
	});
});

describe("useGrowth timeline", () => {
	it("watches rounds without listing the disk while the panel is closed", async () => {
		const fetchMock = vi.fn(async (url: string) => {
			if (url.startsWith("/api/growth")) return response({ available: true, rounds: [round("a", "0", "1", { kind: "baseline" }), round("b", "1", "2", { promptIds: ["u1"] }), round("c", "2", "3", { kind: "user" })] });
			throw new Error(`unexpected ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);
		const { result } = renderHook((props) => useGrowth(props), { initialProps: { ...initialProps, watchRounds: true } });
		await waitFor(() => expect(result.current.rounds).toHaveLength(2));
		expect(fetchMock.mock.calls.map(([url]) => String(url).split("?")[0])).toEqual(["/api/growth"]);
		expect(result.current.rounds.map((r) => [r.kind, r.n])).toEqual([["round", 1], ["user", null]]);
		expect(result.current.selected?.commit).toBe(h("c"));
		expect(result.current.following).toBe(true);
	});

	it("uses the commit's own changes for a round and diffs from the session start for the session total", async () => {
		const c1: GrowthChange[] = [{ status: "A", path: "a.ts", add: 1, del: 0 }];
		const c2: GrowthChange[] = [{ status: "M", path: "b.ts", add: 2, del: 1 }];
		const total: GrowthChange[] = [...c1, ...c2];
		const fetchMock = vi.fn(async (url: string) => {
			const u = new URL(url, "http://local");
			if (u.searchParams.get("list") === "1") return response({ files: [] });
			if (u.searchParams.get("changes") === "1") {
				expect([u.searchParams.get("from"), u.searchParams.get("to")]).toEqual([h("0"), h("2")]);
				return response({ changes: total });
			}
			if (u.pathname === "/api/growth") return response({ available: true, rounds: [round("a", "0", "1", { changes: c1 }), round("b", "1", "2", { changes: c2 })] });
			return response({ entries: [], nextOffset: null });
		});
		vi.stubGlobal("fetch", fetchMock);
		const { result } = renderHook((props) => useGrowth(props), { initialProps: { ...initialProps, active: true } });
		await waitFor(() => expect(result.current.rounds).toHaveLength(2));
		expect(result.current.range).toEqual({ from: h("1"), to: h("2") });
		expect(result.current.changes).toEqual(c2);
		expect(fetchMock.mock.calls.some(([url]) => String(url).includes("changes=1"))).toBe(false);

		act(() => result.current.setScope("session"));
		await waitFor(() => expect(result.current.changes).toEqual(total));
		expect(result.current.range).toEqual({ from: h("0"), to: h("2") });

		act(() => result.current.setScope("round"));
		act(() => result.current.select(h("a")));
		expect(result.current.following).toBe(false);
		expect(result.current.changes).toEqual(c1);
		act(() => result.current.next());
		expect(result.current.following).toBe(true);
		expect(result.current.selected?.commit).toBe(h("b"));
	});

	it("merges live rounds from the event stream without duplicating fetched ones", async () => {
		const fetched = round("a", "0", "1");
		const fetchMock = vi.fn(async (url: string) => (url.startsWith("/api/growth") ? response({ available: true, rounds: [fetched] }) : response({ entries: [], nextOffset: null })));
		vi.stubGlobal("fetch", fetchMock);
		const { result, rerender } = renderHook((props) => useGrowth(props), { initialProps: { ...initialProps, watchRounds: true } });
		await waitFor(() => expect(result.current.rounds).toHaveLength(1));
		rerender({ ...initialProps, watchRounds: true, liveRounds: [fetched, round("b", "1", "2")] });
		expect(result.current.rounds.map((r) => [r.commit[0], r.n])).toEqual([["a", 1], ["b", 2]]);
	});
});

describe("useGrowth request scope", () => {
	it.each(["cwd", "session"] as const)("ignores delayed lazy responses across a %s switch without blocking the new request", async (changed) => {
		const old = deferred<Response>();
		const current = deferred<Response>();
		const fetchMock = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
		vi.stubGlobal("fetch", fetchMock);
		const { result, rerender } = renderHook((props) => useGrowth(props), { initialProps });
		let first!: Promise<void>;
		act(() => { first = result.current.expandLazy("p"); });
		const firstSignal = fetchMock.mock.calls[0][1].signal as AbortSignal;
		rerender({ ...initialProps, ...(changed === "cwd" ? { cwd: "/workspace-b" } : { sessionPath: "/session-b.jsonl" }) });
		expect(firstSignal.aborted).toBe(true);
		await act(async () => { old.resolve(directory("old.txt")); await first; });
		expect(result.current.filePaths).not.toContain("p/old.txt");
		let second!: Promise<void>;
		act(() => { second = result.current.expandLazy("p"); });
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect((fetchMock.mock.calls[1][1].signal as AbortSignal).aborted).toBe(false);
		await act(async () => { current.resolve(directory("new.txt")); await second; });
		expect(result.current.filePaths).toContain("p/new.txt");
		expect(result.current.filePaths).not.toContain("p/old.txt");
	});

	it("does not let an old finally release a new same-path request", async () => {
		const old = deferred<Response>();
		const current = deferred<Response>();
		const fetchMock = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
		vi.stubGlobal("fetch", fetchMock);
		const { result, rerender } = renderHook((props) => useGrowth(props), { initialProps });
		let first!: Promise<void>;
		let second!: Promise<void>;
		act(() => { first = result.current.expandLazy("p"); });
		rerender({ ...initialProps, cwd: "/workspace-b" });
		act(() => { second = result.current.expandLazy("p"); });
		await act(async () => { old.resolve(directory("old.txt")); await first; });
		await act(async () => { await result.current.expandLazy("p"); });
		expect(fetchMock).toHaveBeenCalledTimes(2);
		await act(async () => { current.resolve(directory("new.txt")); await second; });
		expect(result.current.filePaths).toEqual(["p/new.txt"]);
	});

	it("rejects a stale timeline refresh after switching workspaces", async () => {
		const timeline = deferred<Response>();
		const fetchMock = vi.fn(() => timeline.promise);
		vi.stubGlobal("fetch", fetchMock);
		const { result, rerender } = renderHook((props) => useGrowth(props), { initialProps });
		let refresh!: Promise<void>;
		act(() => { refresh = result.current.refresh(); });
		rerender({ ...initialProps, cwd: "/workspace-b", sessionPath: "/session-b.jsonl" });
		// 面板关着：只拉时间轴，不列磁盘
		expect(fetchMock.mock.calls).toHaveLength(1);
		await act(async () => {
			timeline.resolve(response({ available: false, rounds: [round("a", "0", "1")] }));
			await refresh;
		});
		expect(result.current.rounds).toEqual([]);
		expect(result.current.available).toBe(true);
		expect(result.current.loading).toBe(false);
	});

	it("cancels directory pagination on unmount and allows retries after failures", async () => {
		const page = deferred<Response>();
		const fetchMock = vi.fn().mockRejectedValueOnce(new Error("temporary failure")).mockReturnValueOnce(page.promise);
		vi.stubGlobal("fetch", fetchMock);
		const { result, unmount } = renderHook(() => useGrowth(initialProps));
		await act(async () => { await result.current.expandLazy("p"); });
		let request!: Promise<void>;
		act(() => { request = result.current.expandLazy("p"); });
		expect(fetchMock).toHaveBeenCalledTimes(2);
		const signal = fetchMock.mock.calls[1][1].signal as AbortSignal;
		unmount();
		expect(signal.aborted).toBe(true);
		page.resolve(response({ entries: [{ name: "old.txt", kind: "file" }], nextOffset: 1 }));
		await request;
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("does not let a late round listing prime a different workspace cache", async () => {
		const listings = new Map<string, ReturnType<typeof deferred<Response>>>();
		const fetchMock = vi.fn((url: string) => {
			const u = new URL(url, "http://local");
			if (u.searchParams.get("list") === "1") {
				const d = deferred<Response>();
				listings.set(u.searchParams.get("cwd")!, d);
				return d.promise;
			}
			if (u.pathname === "/api/growth") return Promise.resolve(response({ available: true, rounds: [] }));
			return Promise.resolve(response({ entries: [], nextOffset: null }));
		});
		vi.stubGlobal("fetch", fetchMock);
		const props = { ...initialProps, active: true, liveRounds: [round("a", "0", "1")] };
		const { result, rerender } = renderHook((value) => useGrowth(value), { initialProps: props });
		await waitFor(() => expect(listings.has("/workspace-a")).toBe(true));
		rerender({ ...props, cwd: "/workspace-b" });
		await waitFor(() => expect(listings.has("/workspace-b")).toBe(true));
		await act(async () => {
			listings.get("/workspace-a")!.resolve(response({ files: [{ path: "old.txt", size: 1 }] }));
			listings.get("/workspace-b")!.resolve(response({ files: [{ path: "new.txt", size: 1 }] }));
		});
		expect(result.current.filePaths).toEqual(["new.txt"]);
	});
});
