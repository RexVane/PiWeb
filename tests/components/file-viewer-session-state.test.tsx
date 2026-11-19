// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";
import { useFileViewer } from "@/hooks/useFileViewer";
import { safeLocalStorage } from "@/lib/browser-storage";

beforeEach(() => safeLocalStorage.clear());
afterEach(() => { cleanup(); vi.restoreAllMocks(); safeLocalStorage.clear(); });
const scope = (sessionPath: string, cwd = "/workspace") => ({ sessionPath, cwd });
const paths = (viewer: ReturnType<typeof useFileViewer>) => viewer.state.tabs.map((tab) => tab.path);

describe("file tabs belong to a conversation until its viewer is closed", () => {
	it("keeps separate tabs and selection for conversations in the same or another workspace", () => {
		const hook = renderHook((props) => useFileViewer(props), { initialProps: scope("/session-a") });
		act(() => { hook.result.current.open("a.txt"); hook.result.current.open("b.txt"); hook.result.current.select("a.txt"); });
		hook.rerender(scope("/session-b"));
		expect(hook.result.current.state).toEqual({ open: false, tabs: [], active: null });
		act(() => hook.result.current.open("other.txt"));
		hook.rerender(scope("/session-c", "/other-workspace"));
		expect(hook.result.current.state.open).toBe(false);
		act(() => hook.result.current.openTree());
		hook.rerender(scope("/session-a"));
		expect(paths(hook.result.current)).toEqual(["a.txt", "b.txt"]);
		expect(hook.result.current.state).toMatchObject({ open: true, active: "a.txt" });
		hook.rerender(scope("/session-b"));
		expect(paths(hook.result.current)).toEqual(["other.txt"]);
		hook.rerender(scope("/session-c", "/other-workspace"));
		expect(hook.result.current.state).toEqual({ open: true, tabs: [], active: null });
	});

	it("restores tabs on remount without saving document contents", () => {
		const first = renderHook(() => useFileViewer(scope("/session-a")));
		act(() => {
			first.result.current.open("docs", { kind: "dir", lazy: true });
			first.result.current.open("new.txt", { from: "old.txt" });
			first.result.current.openStatic("/skills/demo/references/guide.md", "private document body", "/skills/demo/SKILL.md");
		});
		expect(safeLocalStorage.getItem("piweb.fileViewer.session:/session-a")).not.toContain("private document body");
		first.unmount();
		const second = renderHook(() => useFileViewer(scope("/session-a")), { wrapper: ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode> });
		expect(second.result.current.state).toEqual({ open: true, active: "/skills/demo/references/guide.md", tabs: [
			{ path: "docs", kind: "dir", lazy: true },
			{ path: "new.txt", from: "old.txt" },
			{ path: "/skills/demo/references/guide.md", sourcePath: "/skills/demo/SKILL.md", lazy: true },
		] });
	});

	it("closing the viewer clears every tab in the same conversation, including after switching or reloading", () => {
		const hook = renderHook((props) => useFileViewer(props), { initialProps: scope("/session-a") });
		act(() => { hook.result.current.open("a.txt"); hook.result.current.open("b.txt"); });
		act(() => hook.result.current.close());
		expect(hook.result.current.state).toEqual({ open: false, tabs: [], active: null });
		expect(safeLocalStorage.getItem("piweb.fileViewer.session:/session-a")).toBeNull();
		act(() => hook.result.current.open("fresh.txt"));
		expect(paths(hook.result.current)).toEqual(["fresh.txt"]);
		act(() => hook.result.current.close());
		hook.rerender(scope("/session-b"));
		hook.rerender(scope("/session-a"));
		expect(hook.result.current.state.open).toBe(false);
		hook.unmount();
		const reloaded = renderHook(() => useFileViewer(scope("/session-a")));
		expect(reloaded.result.current.state).toEqual({ open: false, tabs: [], active: null });
		act(() => reloaded.result.current.openTree());
		expect(paths(reloaded.result.current)).toEqual([]);
	});

	it("closing an individual tab retains its neighbors and saves the new selection", () => {
		const hook = renderHook(() => useFileViewer(scope("/session-a")));
		act(() => { hook.result.current.open("a.txt"); hook.result.current.open("b.txt"); hook.result.current.open("c.txt"); hook.result.current.select("b.txt"); });
		act(() => hook.result.current.closeTab("b.txt"));
		expect(hook.result.current.state.active).toBe("c.txt");
		hook.unmount();
		const restored = renderHook(() => useFileViewer(scope("/session-a")));
		expect(paths(restored.result.current)).toEqual(["a.txt", "c.txt"]);
		expect(restored.result.current.state.active).toBe("c.txt");
		act(() => { restored.result.current.closeTab("c.txt"); restored.result.current.closeTab("a.txt"); });
		expect(restored.result.current.state).toEqual({ open: true, tabs: [], active: null });
	});

	it("ignores callbacks from the previous conversation", () => {
		const hook = renderHook((props) => useFileViewer(props), { initialProps: scope("/session-a") });
		act(() => hook.result.current.open("a.txt"));
		const old = hook.result.current;
		hook.rerender(scope("/session-b"));
		act(() => hook.result.current.open("b.txt"));
		act(() => { old.openStatic("late.md", "late response"); old.close(); old.select("a.txt"); });
		expect(paths(hook.result.current)).toEqual(["b.txt"]);
		expect(hook.result.current.state).toMatchObject({ open: true, active: "b.txt" });
		hook.rerender(scope("/session-a"));
		expect(paths(hook.result.current)).toEqual(["a.txt"]);
	});

	it("keeps a session identity while its workspace loads and normalizes Windows paths", () => {
		const hook = renderHook((props) => useFileViewer(props), { initialProps: scope("D:\\Sessions\\A.jsonl", "") });
		act(() => hook.result.current.open("a.txt"));
		hook.rerender(scope("d:/sessions/a.jsonl", "D:/workspace"));
		expect(paths(hook.result.current)).toEqual(["a.txt"]);
		hook.rerender(scope("/Store/a.jsonl"));
		act(() => hook.result.current.open("upper.txt"));
		hook.rerender(scope("/store/a.jsonl"));
		expect(hook.result.current.state.open).toBe(false);
		hook.rerender(scope("/Store/a.jsonl"));
		expect(paths(hook.result.current)).toEqual(["upper.txt"]);
	});

	it("recovers from malformed storage and discards invalid tabs without restoring a body", () => {
		const key = "piweb.fileViewer.session:/session-a";
		safeLocalStorage.setItem(key, "broken json");
		const first = renderHook(() => useFileViewer(scope("/session-a")));
		expect(first.result.current.state.open).toBe(false);
		first.unmount();
		safeLocalStorage.setItem(key, JSON.stringify({ version: 1, open: true, active: "missing", tabs: [
			null, { path: "" }, { path: 123 }, { path: "a.txt", lazy: "true", kind: "unknown", staticContent: "untrusted body" }, { path: "a.txt" }, { path: "b.txt", kind: "file" },
		] }));
		const second = renderHook(() => useFileViewer(scope("/session-a")));
		expect(second.result.current.state).toEqual({ open: true, tabs: [{ path: "a.txt" }, { path: "b.txt", kind: "file" }], active: "b.txt" });
	});
});

describe("恢复页签时丢掉工作区外的绝对路径", () => {
	it("keeps in-workspace absolute tabs, deduplicates them, and preserves selection", () => {
		safeLocalStorage.setItem("piweb.fileViewer.session:/session-a", JSON.stringify({ version: 1, open: true,
			active: "C:/project/src/file.ts", tabs: [{ path: "src/file.ts" }, { path: "C:/project/src/file.ts" }, { path: "C:/other/file.ts" }],
		}));
		const hook = renderHook(() => useFileViewer(scope("/session-a", "C:/project")));
		expect(paths(hook.result.current)).toEqual(["src/file.ts"]);
		expect(hook.result.current.state.active).toBe("src/file.ts");
		act(() => hook.result.current.open("c:\\PROJECT\\docs\\guide.md"));
		expect(hook.result.current.state.active).toBe("docs/guide.md");
	});

	it("drops outside file/dir tabs but keeps upload tabs and sourcePath documents", () => {
		// 直接写入存储，模拟旧版本留下的越界页签（工具卡把绝对路径原样打开过）
		safeLocalStorage.setItem("piweb.fileViewer.session:/session-a", JSON.stringify({
			version: 1, open: true, active: "C:/Users/me/AppData/clash-verge-aifix.yaml", tabs: [
				{ path: "keep.txt" },
				{ path: "C:/Users/me/AppData/clash-verge-aifix.yaml" },
				{ path: "/etc/passwd" },
				{ path: "//server/share/remote.log" },
				{ path: "C:/Users/me/.pi/agent/web-uploads/pic.png", kind: "upload" },
				{ path: "/skills/demo/references/guide.md", sourcePath: "/skills/demo/SKILL.md", lazy: true },
			],
		}));
		const hook = renderHook(() => useFileViewer(scope("/session-a")));
		expect(paths(hook.result.current)).toEqual([
			"keep.txt",
			"C:/Users/me/.pi/agent/web-uploads/pic.png",
			"/skills/demo/references/guide.md",
		]);
		// active 指向被丢的页签时回退到剩下的最后一个
		expect(hook.result.current.state.active).toBe("/skills/demo/references/guide.md");
	});
});
