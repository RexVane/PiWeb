// @vitest-environment jsdom
/**
 * Git 面板：按 Git 的三个区呈现（暂存区 / 工作区 / 冲突），以及头部的 GitHub 身份。
 * 依据 #064 调研里与用户确认的方案：只改名归并，不加 git 写操作。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { GitPanel } from "@/components/GitPanel";

vi.mock("@/lib/highlight", () => ({ languageForPath: () => undefined, highlightLine: () => null }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const files = [
	{ path: "staged.ts", kind: "modified", indexStatus: "M", workStatus: " " },
	{ path: "unstaged.ts", kind: "modified", indexStatus: " ", workStatus: "M" },
	{ path: "brand-new.ts", kind: "untracked", indexStatus: " ", workStatus: "?" },
	{ path: "conflicted.ts", kind: "conflict", indexStatus: "U", workStatus: "U" },
];
const info = { available: true, isRepo: true, root: "/repo", branch: "main", upstream: "origin/main", ahead: 1, behind: 0, detached: false, files, commits: [] };

/** /api/git 与 /api/github 分开应答；identity 传 null 表示取不到 */
function stubFetch(identity: unknown) {
	vi.stubGlobal("fetch", vi.fn(async (url: string) => ({
		ok: true,
		json: async () => (url.includes("/api/github") ? { success: true, data: { identity } } : { success: true, data: info }),
	})));
}

describe("GitPanel 三个区", () => {
	it("暂存区与工作区分别成组，并给出各自的数量", async () => {
		stubFetch(null);
		render(<GitPanel cwd="/repo" onClose={vi.fn()} />);
		await screen.findByText("暂存区");
		expect(screen.getByText("工作区")).toBeTruthy();
		expect(screen.getByText("冲突")).toBeTruthy();
		// 暂存区 1 个、工作区 2 个（未暂存 + 未跟踪）、冲突 1 个
		const counts = screen.getAllByText(/^[0-9]+$/).map((n) => n.textContent);
		expect(counts).toContain("1");
		expect(counts).toContain("2");
	});

	it("未跟踪的新文件归到工作区，并标 ?", async () => {
		stubFetch(null);
		render(<GitPanel cwd="/repo" onClose={vi.fn()} />);
		await screen.findByText("暂存区");
		expect(screen.getByTitle("brand-new.ts")).toBeTruthy();
		expect(screen.getByTitle("unstaged.ts")).toBeTruthy();
		expect(screen.getByTitle("conflicted.ts")).toBeTruthy();
	});

	it("没有变更时不渲染任何分组", async () => {
		stubFetch(null);
		vi.stubGlobal("fetch", vi.fn(async (url: string) => ({
			ok: true,
			json: async () => (url.includes("/api/github") ? { success: true, data: { identity: null } } : { success: true, data: { ...info, files: [] } }),
		})));
		render(<GitPanel cwd="/repo" onClose={vi.fn()} />);
		await screen.findByText("工作区干净，没有变更");
		expect(screen.queryByText("暂存区")).toBeNull();
		expect(screen.queryByText("工作区")).toBeNull();
	});
});

describe("GitPanel GitHub 身份", () => {
	it("有身份时显示头像与 @账号", async () => {
		stubFetch({ login: "RexVane", name: "心安", avatar: "data:image/png;base64,AAAA", source: "gh", url: "https://github.com/RexVane", repo: "RexVane/PiWeb" });
		render(<GitPanel cwd="/repo" onClose={vi.fn()} />);
		expect(await screen.findByText("@RexVane")).toBeTruthy();
		expect(screen.getByText("· RexVane/PiWeb")).toBeTruthy();
		const avatar = document.querySelector('img[src^="data:image/png"]') as HTMLImageElement | null;
		expect(avatar?.getAttribute("alt")).toBe("");
	});

	it("取不到头像时退回首字母，不留空位", async () => {
		stubFetch({ login: "octocat", source: "remote", url: "https://github.com/octocat" });
		render(<GitPanel cwd="/repo" onClose={vi.fn()} />);
		expect(await screen.findByText("@octocat")).toBeTruthy();
		expect(document.querySelector('img[src^="data:image"]')).toBeNull();
		expect(screen.getByText("O")).toBeTruthy();
	});

	it("完全取不到身份时不渲染那一行，也不报错", async () => {
		stubFetch(null);
		render(<GitPanel cwd="/repo" onClose={vi.fn()} />);
		await screen.findByText("暂存区");
		await waitFor(() => expect(screen.queryByText(/^@/)).toBeNull());
	});
});
