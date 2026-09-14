// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useGrowth } from "../src/hooks/useGrowth";
import type { GrowthStep } from "../src/lib/types";

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

const steps: GrowthStep[] = [];
const pending: string[] = [];
const turnStarts: number[] = [];
const initialProps = { cwd: "/workspace-a", sessionPath: "/session-a.jsonl", liveSteps: steps, pending, turnStarts, active: false, connected: true };

beforeEach(() => { localStorage.clear(); });
afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.useRealTimers();
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

	it("rejects stale refresh backfills even when the next workspace is inactive", async () => {
		const ledger = deferred<Response>();
		const disk = deferred<Response>();
		const fetchMock = vi.fn((url: string) => url.startsWith("/api/growth") ? ledger.promise : disk.promise);
		vi.stubGlobal("fetch", fetchMock);
		const { result, rerender } = renderHook((props) => useGrowth(props), { initialProps });
		let refresh!: Promise<void>;
		act(() => { refresh = result.current.refresh(); });
		rerender({ ...initialProps, cwd: "/workspace-b", sessionPath: "/session-b.jsonl" });
		expect(fetchMock.mock.calls).toHaveLength(2);
		await act(async () => {
			ledger.resolve(response({ available: false, steps: [] }));
			disk.resolve(directory("old-root.txt"));
			await refresh;
		});
		expect(result.current.filePaths).toEqual([]);
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

	it("does not let a late snapshot listing prime a different workspace cache", async () => {
		const first = deferred<Response>();
		const second = deferred<Response>();
		const base: GrowthStep = { seq: 1, ts: 1, session: "/session-a.jsonl", kind: "baseline", label: "", tree: "a".repeat(40), parent: "0".repeat(40), initial: true, changes: [], stats: { added: 0, modified: 0, deleted: 0, renamed: 0, add: 0, del: 0 } };
		const fetchMock = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
		vi.stubGlobal("fetch", fetchMock);
		const props = { ...initialProps, liveSteps: [base] };
		const { result, rerender } = renderHook((value) => useGrowth(value), { initialProps: props });
		rerender({ ...props, cwd: "/workspace-b" });
		await act(async () => {
			first.resolve(response({ files: [{ path: "old.txt", size: 1 }] }));
			second.resolve(response({ files: [{ path: "new.txt", size: 1 }] }));
		});
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(result.current.filePaths).toEqual(["new.txt"]);
	});
});
