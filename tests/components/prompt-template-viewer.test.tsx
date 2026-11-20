// @vitest-environment jsdom
import { act, cleanup, render, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useFileViewer } from "@/hooks/useFileViewer";
import { FileViewer } from "@/components/FileViewer";
import { safeLocalStorage } from "@/lib/browser-storage";
import type { GrowthApi } from "@/hooks/useGrowth";

afterEach(() => { cleanup(); safeLocalStorage.clear(); vi.unstubAllGlobals(); });

describe("templates from another workspace in the shared file viewer", () => {
	it("keeps the template's discovery workspace across remounts without saving its body", () => {
		const scope = { cwd: "/chat-workspace", sessionPath: "/session-a" };
		const hook = renderHook(() => useFileViewer(scope));
		const file = "/template-workspace/.pi/prompts/review.md";
		act(() => hook.result.current.openStatic(file, "private template body", file, "/template-workspace"));
		expect(safeLocalStorage.getItem("piweb.fileViewer.session:/session-a")).not.toContain("private template body");
		hook.unmount();
		const restored = renderHook(() => useFileViewer(scope));
		expect(restored.result.current.state.tabs).toEqual([{ path: file, sourcePath: file, sourceCwd: "/template-workspace", lazy: true }]);
	});

	it("reads a restored template against its discovery workspace, not the current chat", async () => {
		const posts: Record<string, unknown>[] = [];
		vi.stubGlobal("fetch", vi.fn(async (_url, init?: RequestInit) => {
			if (init?.body) posts.push(JSON.parse(String(init.body)));
			return new Response(JSON.stringify({ success: true, data: { content: "Restored template content" } }), { status: 200 });
		}));
		const growth = {
			tree: { path: "", name: "", kind: "dir", children: [], counts: { added: 0, modified: 0, deleted: 0, renamed: 0, pending: 0 } },
			expanded: new Set(), fresh: new Set(), filePaths: [], changes: [], rounds: [], selected: null, range: null,
			loading: false, available: true, error: null, scope: "round", revealPath: vi.fn(), toggleDir: vi.fn(), expandAll: vi.fn(), collapseAll: vi.fn(), expandLazy: vi.fn(async () => {}),
			selectLatest: vi.fn(), select: vi.fn(), prev: vi.fn(), next: vi.fn(), setScope: vi.fn(), refresh: vi.fn(async () => {}), recordNow: vi.fn(async () => null),
		} as GrowthApi;
		const file = "/template-workspace/.pi/prompts/review.md";
		render(<FileViewer cwd="/chat-workspace" growth={growth} state={{ open: true, active: file, tabs: [{ path: file, sourcePath: file, sourceCwd: "/template-workspace", lazy: true }] }}
			onClose={vi.fn()} onSelectTab={vi.fn()} onCloseTab={vi.fn()} onOpen={vi.fn()} />);
		await waitFor(() => expect(posts).toContainEqual({ action: "read", cwd: "/template-workspace", filePath: file, sourcePath: file }));
	});
});
