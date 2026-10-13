// @vitest-environment jsdom
/**
 * 文件夹预览:点目录时查看器列目录(而不是报「文件不存在」),能逐层进去、能引用整个文件夹。
 * 目录条目由 /api/files 列举,后端已按 .gitignore 过滤(#102),这里用桩数据验前端行为。
 */
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FileViewer } from "@/components/FileViewer";
import type { GrowthApi } from "@/hooks/useGrowth";
import type { ViewerState } from "@/hooks/useFileViewer";

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

const LISTING = {
	dir: "scripts",
	entries: [
		{ name: "release.mjs", kind: "file", size: 2048 },
		{ name: "publish", kind: "dir" },
	],
	nextOffset: null,
	truncated: false,
};

function growthStub(): GrowthApi {
	return {
		tree: { path: "", name: "", kind: "dir", children: [], counts: { added: 0, modified: 0, deleted: 0, renamed: 0, pending: 0 } },
		expanded: new Set<string>(),
		fresh: new Set<string>(),
		filePaths: [],
		changes: [],
		rounds: [],
		selected: null,
		range: null,
		loading: false,
		available: true,
		error: null,
		revealPath: vi.fn(),
		toggleDir: vi.fn(),
		expandAll: vi.fn(),
		collapseAll: vi.fn(),
		expandLazy: vi.fn(async () => {}),
	} as unknown as GrowthApi;
}

function renderViewer(state: ViewerState, onOpen = vi.fn()) {
	const fetchMock = vi.fn(async (url: string) => ({
		ok: true,
		status: 200,
		json: async () => ({ success: true, data: url.includes("/api/files?") ? LISTING : {} }),
	}));
	vi.stubGlobal("fetch", fetchMock);
	render(
		<FileViewer
			state={state}
			growth={growthStub()}
			cwd="D:/ws"
			onClose={vi.fn()}
			onSelectTab={vi.fn()}
			onCloseTab={vi.fn()}
			onOpen={onOpen}
			onReference={vi.fn()}
			onOpenEditor={vi.fn()}
		/>,
	);
	return { fetchMock, onOpen };
}

it("kind=dir 的页签列目录条目,而不是去读文件内容", async () => {
	const { fetchMock } = renderViewer({ open: true, tabs: [{ path: "scripts", kind: "dir", lazy: true }], active: "scripts" });
	expect(await screen.findByText("release.mjs")).toBeTruthy();
	expect(screen.getByText("publish")).toBeTruthy();
	// 只问了目录列举,没有去读文件
	expect(fetchMock.mock.calls.some(([url]) => String(url).includes("read=1"))).toBe(false);
	expect(screen.queryByText("文件不存在")).toBeNull();
});

it("点条目进下一层:目录带 kind、文件不带;相对路径拼对", async () => {
	const { onOpen } = renderViewer({ open: true, tabs: [{ path: "scripts", kind: "dir", lazy: true }], active: "scripts" });
	fireEvent.click(await screen.findByText("publish"));
	expect(onOpen).toHaveBeenCalledWith("scripts/publish", { kind: "dir", lazy: true });
	fireEvent.click(screen.getByText("release.mjs"));
	expect(onOpen).toHaveBeenCalledWith("scripts/release.mjs", { lazy: true });
});

it("没带 kind 也认得出文件夹:读文件报 400 时探一下目录接口就当文件夹打开", async () => {
	const fetchMock = vi.fn(async (url: string) => {
		if (String(url).includes("read=1")) return { ok: false, status: 400, json: async () => ({ success: false, error: "not a file" }) };
		return { ok: true, status: 200, json: async () => ({ success: true, data: LISTING }) };
	});
	vi.stubGlobal("fetch", fetchMock);
	render(
		<FileViewer
			state={{ open: true, tabs: [{ path: "scripts", lazy: true }], active: "scripts" }}
			growth={growthStub()}
			cwd="D:/ws"
			onClose={vi.fn()}
			onSelectTab={vi.fn()}
			onCloseTab={vi.fn()}
			onOpen={vi.fn()}
			onReference={vi.fn()}
			onOpenEditor={vi.fn()}
		/>,
	);
	expect(await screen.findByText("release.mjs")).toBeTruthy();
	await waitFor(() => expect(screen.queryByText("文件不存在")).toBeNull());
});
