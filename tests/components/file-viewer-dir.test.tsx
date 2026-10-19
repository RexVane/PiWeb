// @vitest-environment jsdom
/**
 * 文件夹预览:点目录时查看器列目录(而不是报「文件不存在」),能逐层进去、能引用整个文件夹。
 * 目录条目由 /api/files 列举,后端已按 .gitignore 过滤(#102),这里用桩数据验前端行为。
 */
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FileViewer } from "@/components/FileViewer";
import type { GrowthApi } from "@/hooks/useGrowth";
import type { ViewerState } from "@/hooks/useFileViewer";
import { useFileViewer } from "@/hooks/useFileViewer";

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

it("文件大小按 KB/MB 显示,而不是一串字节数", async () => {
	renderViewer({ open: true, tabs: [{ path: "scripts", kind: "dir", lazy: true }], active: "scripts" });
	expect(await screen.findByText("2.00 KB")).toBeTruthy();
	expect(screen.queryByText("2048 B")).toBeNull();
});

it("切到另一个文件夹页签时,新目录回来之前不显示上一个目录的条目", async () => {
	// 回归:上一个目录的条目一直挂着直到新请求返回,这时点上去会拼出 docs/release.mjs 这种不存在的路径
	let releaseDocs: (() => void) | null = null;
	const fetchMock = vi.fn((url: string) => {
		const body = (data: unknown) => ({ ok: true, status: 200, json: async () => ({ success: true, data }) });
		if (String(url).includes("path=docs")) {
			return new Promise((resolve) => {
				releaseDocs = () => resolve(body({ dir: "docs", entries: [{ name: "guide.md", kind: "file", size: 10 }], nextOffset: null, truncated: false }));
			});
		}
		return Promise.resolve(body(LISTING));
	});
	vi.stubGlobal("fetch", fetchMock);
	const onOpen = vi.fn();
	const props = { growth: growthStub(), cwd: "D:/ws", onClose: vi.fn(), onSelectTab: vi.fn(), onCloseTab: vi.fn(), onOpen, onReference: vi.fn(), onOpenEditor: vi.fn() };
	const tabs = [{ path: "scripts", kind: "dir" as const, lazy: true }, { path: "docs", kind: "dir" as const, lazy: true }];
	const view = render(<FileViewer state={{ open: true, tabs, active: "scripts" }} {...props} />);
	expect(await screen.findByText("release.mjs")).toBeTruthy();

	view.rerender(<FileViewer state={{ open: true, tabs, active: "docs" }} {...props} />);
	expect(screen.queryByText("release.mjs")).toBeNull();
	expect(screen.getByTestId("viewer-dir").textContent).toContain("加载中");
	releaseDocs!();
	expect(await screen.findByText("guide.md")).toBeTruthy();
	fireEvent.click(screen.getByText("guide.md"));
	expect(onOpen).toHaveBeenCalledWith("docs/guide.md", { lazy: true });
});

it("目录列不出来时显示错误,而不是「0 项」", async () => {
	vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 403, json: async () => ({ success: false, error: "permission denied" }) })));
	render(
		<FileViewer
			state={{ open: true, tabs: [{ path: "secret", kind: "dir", lazy: true }], active: "secret" }}
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
	expect(await screen.findByText("permission denied")).toBeTruthy();
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

it("冷树也能快速打开索引中的深层文件，加载期间按下箭头不会丢失首项", async () => {
	let complete!: () => void;
	const fetchMock = vi.fn(() => new Promise((resolve) => {
		complete = () => resolve({ ok: true, json: async () => ({ success: true, data: { files: ["src/components/GitPanel.tsx"], source: "git", truncated: false } }) });
	}));
	vi.stubGlobal("fetch", fetchMock);
	const onOpen = vi.fn();
	render(<FileViewer state={{ open: true, tabs: [], active: null }} growth={growthStub()} cwd="/cold-quick-open" onClose={vi.fn()} onSelectTab={vi.fn()} onCloseTab={vi.fn()} onOpen={onOpen} />);
	fireEvent.click(screen.getByTitle(/Ctrl\/⌘\+P/));
	const input = screen.getByPlaceholderText("输入文件名打开…");
	fireEvent.change(input, { target: { value: "GitPanel" } });
	fireEvent.keyDown(input, { key: "ArrowDown" });
	expect(screen.queryByText("没有匹配的文件")).toBeNull();
	complete();
	await screen.findByText("GitPanel.tsx");
	fireEvent.keyDown(input, { key: "Enter" });
	expect(onOpen).toHaveBeenCalledWith("src/components/GitPanel.tsx");
	expect(fetchMock).toHaveBeenCalledWith("/api/files?index=1&cwd=%2Fcold-quick-open", { cache: "no-store" });
});

it("快速打开索引失败时显示错误，不冒充无匹配", async () => {
	vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 403, json: async () => ({ success: false, error: "index denied" }) })));
	render(<FileViewer state={{ open: true, tabs: [], active: null }} growth={growthStub()} cwd="/denied-quick-open" onClose={vi.fn()} onSelectTab={vi.fn()} onCloseTab={vi.fn()} onOpen={vi.fn()} />);
	fireEvent.click(screen.getByTitle(/Ctrl\/⌘\+P/));
	expect(await screen.findByRole("alert")).toHaveProperty("textContent", "index denied");
	expect(screen.queryByText("没有匹配的文件")).toBeNull();
});

it.each(["docs/guide.md", "D:/ws/docs/guide.md"])("相对工作区链接按当前文件 %s 解析，外部链接和锚点保持 href", async (current) => {
	vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ success: true, data: { content: "[文件](../src/%E4%B8%AD%E6%96%87.ts#L2) [外部](https://example.com) [锚点](#section)", binary: false, truncated: false } }) })));
	const onOpen = vi.fn();
	render(<FileViewer state={{ open: true, tabs: [{ path: current, lazy: true }], active: current }} growth={growthStub()} cwd="D:/ws" onClose={vi.fn()} onSelectTab={vi.fn()} onCloseTab={vi.fn()} onOpen={onOpen} />);
	fireEvent.click(await screen.findByRole("link", { name: "文件" }));
	expect(onOpen).toHaveBeenCalledWith(current.startsWith("D:") ? "D:/ws/src/中文.ts" : "src/中文.ts", { lazy: true });
	expect(screen.getByRole("link", { name: "外部" }).getAttribute("href")).toBe("https://example.com");
	expect(screen.getByRole("link", { name: "锚点" }).getAttribute("href")).toBe("#section");
});

it("技能参考文档在查看器新页签打开，第二级链接继续带原始来源", async () => {
	const root = "/skills/demo/SKILL.md";
	const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
		const body = JSON.parse(String(init?.body));
		return { ok: true, json: async () => ({ success: true, data: { content: body.filePath.endsWith("client.md") ? "[继续](nested/next.md)" : "最终内容" } }) };
	});
	vi.stubGlobal("fetch", fetchMock);
	function Harness() {
		const viewer = useFileViewer();
		return <><button onClick={() => viewer.openStatic(root, "[客户端](references/client.md)")}>打开技能</button><FileViewer state={viewer.state} growth={growthStub()} cwd="/ws" onClose={viewer.close} onSelectTab={viewer.select} onCloseTab={viewer.closeTab} onOpen={viewer.open} onOpenContent={viewer.openStatic} /></>;
	}
	render(<Harness />);
	fireEvent.click(screen.getByText("打开技能"));
	fireEvent.click(await screen.findByRole("link", { name: "客户端" }));
	fireEvent.click(await screen.findByRole("link", { name: "继续" }));
	expect(await screen.findByText("最终内容")).toBeTruthy();
	expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
		{ action: "read", cwd: "/ws", filePath: "/skills/demo/references/client.md", sourcePath: root },
		{ action: "read", cwd: "/ws", filePath: "/skills/demo/references/nested/next.md", sourcePath: root },
	]);
});

it("技能链接读取被拒时留在原文档内显示错误", async () => {
	vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({ success: false, error: "linked resource escapes" }) })));
	const onOpenContent = vi.fn();
	render(<FileViewer state={{ open: true, tabs: [{ path: "/skills/demo/SKILL.md", staticContent: "[越界](../../secret.md)" }], active: "/skills/demo/SKILL.md" }} growth={growthStub()} cwd="/ws" onClose={vi.fn()} onSelectTab={vi.fn()} onCloseTab={vi.fn()} onOpen={vi.fn()} onOpenContent={onOpenContent} />);
	fireEvent.click(await screen.findByRole("link", { name: "越界" }));
	expect(await screen.findByRole("alert")).toHaveProperty("textContent", "linked resource escapes");
	expect(screen.getByRole("link", { name: "越界" })).toBeTruthy();
	expect(onOpenContent).not.toHaveBeenCalled();
});

it("关闭查看器后才完成的技能链接请求不会重新打开文档", async () => {
	let complete!: (response: unknown) => void;
	vi.stubGlobal("fetch", vi.fn(() => new Promise((resolve) => { complete = resolve; })));
	const onOpenContent = vi.fn();
	const tabs = [{ path: "/skills/demo/SKILL.md", staticContent: "[参考](references/client.md)" }];
	const props = { growth: growthStub(), cwd: "/ws", onClose: vi.fn(), onSelectTab: vi.fn(), onCloseTab: vi.fn(), onOpen: vi.fn(), onOpenContent };
	const view = render(<FileViewer {...props} state={{ open: true, tabs, active: tabs[0].path }} />);
	fireEvent.click(await screen.findByRole("link", { name: "参考" }));
	view.rerender(<FileViewer {...props} state={{ open: false, tabs, active: tabs[0].path }} />);
	await act(async () => { complete({ ok: true, json: async () => ({ success: true, data: { content: "迟到的内容" } }) }); });
	expect(onOpenContent).not.toHaveBeenCalled();
	expect(screen.queryByRole("dialog")).toBeNull();
});
