// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FileViewer } from "@/components/FileViewer";
import type { GrowthApi } from "@/hooks/useGrowth";
import type { ViewerState } from "@/hooks/useFileViewer";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const body = (data: unknown) => ({ ok: true, status: 200, json: async () => ({ success: true, data }) });
const failure = (status: number, errorCode: string, error: string) => ({ ok: false, status, json: async () => ({ success: false, errorCode, error }) });
function growth(overrides: Partial<GrowthApi> = {}): GrowthApi {
	return {
		tree: { path: "", name: "", kind: "dir", children: [], counts: { added: 0, modified: 0, deleted: 0, renamed: 0, pending: 0 } },
		expanded: new Set(), fresh: new Set(), filePaths: [], changes: [], rounds: [], selected: null, range: null,
		loading: false, available: true, error: null, scope: "round",
		revealPath: vi.fn(), toggleDir: vi.fn(), expandAll: vi.fn(), collapseAll: vi.fn(), expandLazy: vi.fn(async () => {}),
		selectLatest: vi.fn(), select: vi.fn(), prev: vi.fn(), next: vi.fn(), setScope: vi.fn(), refresh: vi.fn(async () => {}), recordNow: vi.fn(async () => null),
		...overrides,
	};
}
const callbacks = () => ({ onClose: vi.fn(), onSelectTab: vi.fn(), onCloseTab: vi.fn(), onOpen: vi.fn() });
const state = (path: string, lazy = true): ViewerState => ({ open: true, tabs: [{ path, lazy }], active: path });

it("disk files reread after refresh and reopening the same retained tab", async () => {
	let content = "first content";
	vi.stubGlobal("fetch", vi.fn(async () => body({ content, binary: false, truncated: false })));
	const props = { growth: growth(), cwd: "/viewer-refresh", ...callbacks() };
	const open = state("notes.txt");
	const view = render(<FileViewer {...props} state={open} />);
	await waitFor(() => expect(view.container.querySelector("pre code, pre:not([aria-hidden])")?.textContent).toBe("first content"));
	content = "refreshed content";
	fireEvent.click(screen.getByRole("button", { name: "刷新" }));
	await waitFor(() => expect(view.container.querySelector("pre code, pre:not([aria-hidden])")?.textContent).toBe("refreshed content"));
	view.rerender(<FileViewer {...props} state={{ ...open, open: false }} />);
	content = "reopened content";
	view.rerender(<FileViewer {...props} state={open} />);
	await waitFor(() => expect(view.container.querySelector("pre code, pre:not([aria-hidden])")?.textContent).toBe("reopened content"));
	expect(screen.queryByText("first content")).toBeNull();
});

it("directory refresh replaces the previous page", async () => {
	let name = "old.txt";
	vi.stubGlobal("fetch", vi.fn(async () => body({ dir: "docs", entries: [{ name, kind: "file" }], nextOffset: null, truncated: false })));
	render(<FileViewer growth={growth()} cwd="/viewer-dir-refresh" state={{ open: true, tabs: [{ path: "docs", kind: "dir" }], active: "docs" }} {...callbacks()} />);
	await screen.findByText("old.txt");
	name = "new.txt";
	fireEvent.click(screen.getByRole("button", { name: "刷新" }));
	await screen.findByText("new.txt");
	expect(screen.queryByText("old.txt")).toBeNull();
});

it.each([
	["missing-snapshot", failure(404, "GROWTH_NOT_FOUND", "file not found in this snapshot"), "正在显示磁盘上的当前内容。"],
	["failed-snapshot", failure(500, "GROWTH_FAILED", "history unavailable"), "所选版本的内容不可用，下面显示磁盘上的当前内容。"],
	["metadata-only", body({ contentOmitted: true }), "本轮仅记录了文件信息，下面显示磁盘上的当前内容。"],
] as const)("shows the live disk file and its source for %s", async (caseName, snapshot, notice) => {
	vi.stubGlobal("fetch", vi.fn(async (url: string) => url.startsWith("/api/growth")
		? snapshot : body({ content: "current contents", binary: false, truncated: false })));
	const { container } = render(<FileViewer growth={growth({ range: { from: "before", to: "after" } })} cwd={"/viewer-" + caseName} state={state("present.txt", false)} {...callbacks()} />);
	await screen.findByText(notice);
	expect(container.querySelector("pre:not([aria-hidden])")?.textContent).toBe("current contents");
});

it("reads a current file missing from the selected Git revision when Content is selected", async () => {
	vi.stubGlobal("fetch", vi.fn(async (url: string) => {
		if (url.includes("&cat=")) return failure(404, "VALIDATION_ERROR", "missing Git object");
		if (url.includes("&diff=")) return body({ patch: "", binary: false, truncated: false });
		return body({ content: "new disk version", binary: false, truncated: false });
	}));
	const open: ViewerState = { open: true, active: "new.txt", tabs: [{ path: "new.txt", git: { mode: "staged" } }] };
	const { container } = render(<FileViewer growth={growth()} cwd="/viewer-missing-index" state={open} {...callbacks()} />);
	fireEvent.click(screen.getByRole("radio", { name: "内容" }));
	await screen.findByText("所选版本的内容不可用，下面显示磁盘上的当前内容。");
	expect(container.querySelector("pre:not([aria-hidden])")?.textContent).toBe("new disk version");
});

it("reports the disk read error without probing a directory or declaring the file missing", async () => {
	const fetchMock = vi.fn(async (_url: string) => failure(403, "EACCES", "没有权限访问请求的资源。"));
	vi.stubGlobal("fetch", fetchMock);
	render(<FileViewer growth={growth()} cwd="/viewer-access" state={state("private.txt")} {...callbacks()} />);
	await screen.findByText("没有权限访问请求的资源。");
	expect(screen.queryByText("此路径在当前工作区中不存在")).toBeNull();
	expect(fetchMock.mock.calls.every(([url]) => url.includes("read=1"))).toBe(true);
});

it("offers filename search after a genuine miss and opens the chosen full path", async () => {
	vi.stubGlobal("fetch", vi.fn(async (url: string) => url.includes("index=1")
		? body({ files: ["src/ui/notes.txt", "tests/notes.txt"], source: "git", truncated: false })
		: failure(404, "FILE_NOT_FOUND", "file not found")));
	const actions = callbacks();
	render(<FileViewer growth={growth()} cwd="/viewer-find-by-name" state={state("notes.txt")} {...actions} />);
	fireEvent.click(await screen.findByRole("button", { name: "按文件名查找" }));
	expect((screen.getByPlaceholderText("输入文件名打开…") as HTMLInputElement).value).toBe("notes.txt");
	fireEvent.click(await screen.findByRole("button", { name: /src\/ui\/notes.txt/ }));
	expect(actions.onOpen).toHaveBeenCalledWith("src/ui/notes.txt");
});

it("a previous workspace response cannot display under the same path in another workspace", async () => {
	let complete!: (response: unknown) => void;
	vi.stubGlobal("fetch", vi.fn(async (url: string) => url.includes("cwd=%2Fsecond-viewer")
		? new Promise((resolve) => { complete = resolve; }) : body({ content: "first workspace", binary: false, truncated: false })));
	const props = { growth: growth(), state: state("same.txt"), ...callbacks() };
	const view = render(<FileViewer {...props} cwd="/first-viewer" />);
	await waitFor(() => expect(view.container.querySelector("pre code, pre:not([aria-hidden])")?.textContent).toBe("first workspace"));
	view.rerender(<FileViewer {...props} cwd="/second-viewer" />);
	expect(screen.queryByText("first workspace")).toBeNull();
	await act(async () => complete(body({ content: "second workspace", binary: false, truncated: false })));
	await waitFor(() => expect(view.container.querySelector("pre code, pre:not([aria-hidden])")?.textContent).toBe("second workspace"));
});

it.each([
	["R", "similarity index 100%\nrename from old.txt\nrename to new.txt", "after"],
	["M", "old mode 100644\nnew mode 100755", "after"],
	["A", "new file mode 100644", "after"],
	["D", "deleted file mode 100644", "before"],
] as const)("a %s change without hunks shows metadata notice and reads the correct tree", async (status, patch, expectedTree) => {
	const cwd = "/viewer-metadata-" + status;
	const fetchMock = vi.fn(async (url: string) => body(url.includes("content=1")
		? { content: "", binary: false, truncated: false } : { patch: "diff --git a/old.txt b/new.txt\n" + patch + "\n", binary: false, truncated: false }));
	vi.stubGlobal("fetch", fetchMock);
	render(<FileViewer growth={growth({ range: { from: "before", to: "after" }, changes: [{ path: "new.txt", status, add: 0, del: 0 }] })} cwd={cwd} state={state("new.txt", false)} {...callbacks()} />);
	await screen.findByText("文件名、权限或其他元信息已改变，正文没有变化。");
	expect(screen.queryByText(/此文件没有变化/)).toBeNull();
	expect(fetchMock.mock.calls.some(([url]) => url.includes("tree=" + expectedTree + "&"))).toBe(true);
});

it("large snapshot contents evict older cached files by bytes and explicit refresh bypasses a retained snapshot", async () => {
	const fetchMock = vi.fn(async (url: string) => body({ content: new URL(url, "http://local").searchParams.get("path") + ":" + "x".repeat(1024 * 1024), binary: false, truncated: false }));
	vi.stubGlobal("fetch", fetchMock);
	const props = { cwd: "/viewer-cache-bytes", growth: growth({ range: { from: "before", to: "after" } }), ...callbacks() };
	const view = render(<FileViewer {...props} state={state("large0.txt", false)} />);
	for (let index = 0; index < 5; index += 1) {
		view.rerender(<FileViewer {...props} state={state("large" + index + ".txt", false)} />);
		await waitFor(() => expect(view.container.querySelector("pre code, pre:not([aria-hidden])")?.textContent?.startsWith("large" + index + ".txt:")).toBe(true));
	}
	const readsOf = (path: string) => fetchMock.mock.calls.filter(([url]) => new URL(url, "http://local").searchParams.get("path") === path).length;
	view.rerender(<FileViewer {...props} state={state("large0.txt", false)} />);
	await waitFor(() => expect(readsOf("large0.txt")).toBe(2));
	await waitFor(() => expect(view.container.textContent).toContain("large0.txt:"));
	fireEvent.click(screen.getByRole("button", { name: "刷新" }));
	await waitFor(() => expect(readsOf("large0.txt")).toBe(3));
});
