// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { GitPanel } from "@/components/GitPanel";

vi.mock("@/lib/highlight", () => ({ languageForPath: () => undefined, highlightLine: () => null }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((yes) => { resolve = yes; });
	return { promise, resolve };
}
const info = (overrides = {}) => ({ available: true, isRepo: true, root: "/repo", branch: "main", upstream: null, ahead: 0, behind: 0, detached: false,
	files: ["a.ts", "b.ts"].map((path) => ({ path, kind: "modified", indexStatus: " ", workStatus: "M" })), commits: [], ...overrides });
const response = (data: unknown) => ({ ok: true, json: async () => ({ success: true, data }) });
const patch = (text: string) => response({ patch: `@@ -0,0 +1 @@\n+${text}\n`, truncated: false, binary: false });

describe("GitPanel request isolation", () => {
	it("ignores late A diff under B's title and aborts on view exit/unmount", async () => {
		const a = deferred<ReturnType<typeof response>>();
		const b = deferred<ReturnType<typeof response>>();
		const signals: AbortSignal[] = [];
		vi.stubGlobal("fetch", vi.fn((url: string, options: RequestInit) => {
			if (!url.includes("diff=")) return Promise.resolve(response(info()));
			signals.push(options.signal as AbortSignal);
			return url.includes("diff=a.ts") ? a.promise : b.promise;
		}));
		const { unmount } = render(<GitPanel cwd="/repo" onClose={vi.fn()} />);
		fireEvent.click(await screen.findByTitle("a.ts"));
		fireEvent.click(screen.getByTitle("返回"));
		expect(signals[0].aborted).toBe(true);
		fireEvent.click(screen.getByTitle("b.ts"));
		await act(async () => b.resolve(patch("B result")));
		expect(screen.getByTitle("b.ts")).toBeTruthy();
		expect(screen.getByText("B result", { exact: false })).toBeTruthy();
		await act(async () => a.resolve(patch("stale A result")));
		expect(screen.queryByText("stale A result", { exact: false })).toBeNull();
		expect(screen.getByText("B result", { exact: false })).toBeTruthy();
		unmount();
		expect(signals[1].aborted).toBe(true);
	});
	it("ignores late status responses after cwd switches", async () => {
		const old = deferred<ReturnType<typeof response>>();
		vi.stubGlobal("fetch", vi.fn((url: string) => url.includes("old") ? old.promise : Promise.resolve(response(info({ branch: "new-branch" })))));
		const { rerender } = render(<GitPanel cwd="/old" onClose={vi.fn()} />);
		rerender(<GitPanel cwd="/new" onClose={vi.fn()} />);
		await screen.findByText("new-branch");
		await act(async () => old.resolve(response(info({ branch: "old-branch" }))));
		expect(screen.queryByText("old-branch")).toBeNull();
		expect(screen.getByText("new-branch")).toBeTruthy();
	});
	it("shows unknown status instead of clean while retaining valid branch/commits", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => response(info({ files: [], statusError: "git status timed out", commits: [{ hash: "abc123", subject: "prior commit", author: "test", relative: "today" }] }))));
		render(<GitPanel cwd="/repo" onClose={vi.fn()} />);
		await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("git status timed out"));
		expect(screen.queryByText("工作区干净，没有变更")).toBeNull();
		expect(screen.getByText("main")).toBeTruthy();
		expect(screen.getByText("prior commit")).toBeTruthy();
	});
});
