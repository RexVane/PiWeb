// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { GitPanel } from "@/components/GitPanel";
import { FileViewer } from "@/components/FileViewer";
import type { GrowthApi } from "@/hooks/useGrowth";
import type { ViewerState } from "@/hooks/useFileViewer";

vi.mock("@/lib/highlight", () => ({
	languageForPath: () => "typescript",
	highlightLine: (text: string) => text,
	highlightCode: (text: string) => text,
}));

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

const jsonResponse = (data: unknown, ok = true, status = 200) => ({
	ok,
	status,
	json: async () => (ok ? { success: true, data } : { success: false, error: (data as { error?: string })?.error ?? "failed" }),
});

function stubGrowth(): GrowthApi {
	return {
		tree: { path: "", name: "", kind: "dir", children: [], counts: { added: 0, modified: 0, deleted: 0, renamed: 0, pending: 0 } },
		expanded: new Set(),
		fresh: new Set(),
		filePaths: [],
		changes: [],
		rounds: [],
		selected: null,
		range: null,
		loading: false,
		available: true,
		error: null,
		scope: "round",
		revealPath: vi.fn(),
		toggleDir: vi.fn(),
		expandAll: vi.fn(),
		collapseAll: vi.fn(),
		expandLazy: vi.fn(async () => {}),
		selectLatest: vi.fn(),
		select: vi.fn(),
		prev: vi.fn(),
		next: vi.fn(),
		setScope: vi.fn(),
		refresh: vi.fn(async () => {}),
		recordNow: vi.fn(async () => null),
	};
}

describe("GitPanel compact workbench", () => {
	it("routes file clicks and commit-file clicks to onOpenDiff instead of inline drawer view", async () => {
		const onOpenDiff = vi.fn();
		const onMutated = vi.fn();
		const baseInfo = {
			available: true,
			isRepo: true,
			root: "/repo",
			branch: "main",
			upstream: "origin/main",
			ahead: 1,
			behind: 0,
			detached: false,
			files: [
				{ path: "staged.ts", kind: "modified", indexStatus: "M", workStatus: " " },
				{ path: "work.ts", kind: "modified", indexStatus: " ", workStatus: "M" },
			],
			commits: [{ hash: "abc1234", subject: "feat: upgrade", author: "dev", relative: "1h ago" }],
		};

		const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
			if (url.includes("/api/github")) return jsonResponse({ identity: null });
			if (url.includes("commitFiles=abc1234")) {
				return jsonResponse({
					hash: "abc1234",
					title: "abc1234 feat: upgrade",
					files: [{ path: "old.ts", status: "M", add: 5, del: 2, binary: false }],
				});
			}
			if (init?.method === "POST") {
				const body = JSON.parse(String(init.body));
				if (body.action === "stage") {
					return jsonResponse({
						info: {
							...baseInfo,
							files: [
								{ path: "staged.ts", kind: "modified", indexStatus: "M", workStatus: " " },
								{ path: "work.ts", kind: "modified", indexStatus: "M", workStatus: " " },
							],
						},
					});
				}
				if (body.action === "commit") {
					return jsonResponse({
						hash: "def5678",
						summary: body.message,
						info: {
							...baseInfo,
							files: [],
							commits: [{ hash: "def5678", subject: body.message, author: "dev", relative: "just now" }, ...baseInfo.commits],
						},
					});
				}
				if (body.action === "push") return jsonResponse({ output: "ok", info: { ...baseInfo, ahead: 0 } });
			}
			return jsonResponse(baseInfo);
		});
		vi.stubGlobal("fetch", fetchMock);

		render(<GitPanel cwd="/repo" onClose={vi.fn()} onOpenDiff={onOpenDiff} onMutated={onMutated} />);
		await screen.findByTitle("work.ts");

		// Clicking a working tree file delegates directly to FileViewer via onOpenDiff
		fireEvent.click(screen.getByTitle("work.ts"));
		expect(onOpenDiff).toHaveBeenCalledWith({ path: "work.ts", mode: "worktree", label: "工作区差异" });
		expect(screen.queryByTestId("diff-viewport")).toBeNull();

		// Stage single file via + button
		fireEvent.click(screen.getByRole("button", { name: "暂存 work.ts" }));
		await waitFor(() => expect(onMutated).toHaveBeenCalledTimes(1));

		// Commit staged changes
		const input = screen.getByLabelText("提交");
		fireEvent.change(input, { target: { value: "chore: ship it" } });
		fireEvent.click(screen.getByRole("button", { name: "提交" }));
		await waitFor(() => expect(screen.getByText("已提交 def5678")).toBeTruthy());

		// Expand commit files cleanly inline and open commit file in viewer
		fireEvent.click(screen.getByText("feat: upgrade"));
		const commitFile = await screen.findByTitle("old.ts");
		fireEvent.click(commitFile);
		expect(onOpenDiff).toHaveBeenLastCalledWith({
			path: "old.ts",
			mode: "commit",
			hash: "abc1234",
			label: "abc1234 · feat: upgrade",
		});

		// Push button dispatches push POST
		fireEvent.click(screen.getByRole("button", { name: "推送" }));
		await waitFor(() => expect(screen.getByText("推送成功")).toBeTruthy());
	});
});

describe("FileViewer Git side-by-side diff & hunk staging", () => {
	it("loads full-context Git diff in split mode and toggles hunk staging", async () => {
		let patch = "--- a/app.ts\n+++ b/app.ts\n@@ -1,3 +1,3 @@\n line1\n-oldWord\n+newWord\n line3\n";
		const onGitMutated = vi.fn();
		const onOpen = vi.fn();
		const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
			if (init?.method === "POST") {
				const body = JSON.parse(String(init.body));
				expect(body.action).toBe("stageHunk");
				expect(body.blockIndex).toBe(0);
				patch = "";
				return jsonResponse({ info: { files: [{ path: "app.ts", kind: "modified", indexStatus: "M", workStatus: " " }] } });
			}
			expect(url).toContain("/api/git?");
			expect(url).toContain("full=1");
			return jsonResponse({ patch, binary: false, truncated: false });
		});
		vi.stubGlobal("fetch", fetchMock);

		const state: ViewerState = {
			open: true,
			active: "app.ts",
			tabs: [{ path: "app.ts", git: { mode: "worktree", label: "工作区差异" } }],
		};

		render(
			<FileViewer
				state={state}
				growth={stubGrowth()}
				cwd="/repo"
				onClose={vi.fn()}
				onSelectTab={vi.fn()}
				onCloseTab={vi.fn()}
				onOpen={onOpen}
				onGitMutated={onGitMutated}
			/>,
		);

		expect(await screen.findByTestId("split-diff")).toBeTruthy();
		// Layout toggle between split & inline works
		fireEvent.click(screen.getByRole("radio", { name: "行内" }));
		expect(document.querySelector('[data-layout="inline"]')).toBeTruthy();
		fireEvent.click(screen.getByRole("radio", { name: "并排" }));
		expect(await screen.findByTestId("split-diff")).toBeTruthy();

		// Stage hunk checkbox triggers stageHunk POST and refreshes diff
		fireEvent.click(screen.getByRole("button", { name: "暂存此块 #1" }));
		await waitFor(() => expect(onGitMutated).toHaveBeenCalledTimes(1));
		await screen.findByText("这一范围内此文件没有变化");
	});

	it("shows both commit hash confirmation and pushError when commit+push partially fails, and includes from path on batch unstage", async () => {
		const posts: Array<Record<string, unknown>> = [];
		const baseInfo = {
			available: true,
			isRepo: true,
			root: "/repo",
			branch: "main",
			upstream: "origin/main",
			ahead: 0,
			behind: 0,
			detached: false,
			files: [{ path: "new.ts", from: "old.ts", kind: "renamed", indexStatus: "R", workStatus: " " }],
			commits: [],
		};
		vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
			if (url.includes("/api/github")) return jsonResponse({ identity: null });
			if (init?.method === "POST") {
				const body = JSON.parse(String(init.body));
				posts.push(body);
				if (body.action === "unstage") return jsonResponse({ info: baseInfo });
				if (body.action === "commit") {
					return jsonResponse({
						hash: "1a2b3c4",
						summary: body.message,
						pushed: false,
						pushError: "rejected by remote",
						info: { ...baseInfo, files: [], ahead: 1 },
					});
				}
			}
			return jsonResponse(baseInfo);
		}));

		render(<GitPanel cwd="/repo" onClose={vi.fn()} onOpenDiff={vi.fn()} />);
		await screen.findByTitle("new.ts");

		// Batch unstage on staged area includes both old.ts and new.ts
		fireEvent.click(screen.getByTitle("全部取消暂存"));
		await waitFor(() => expect(posts[0]).toMatchObject({ action: "unstage", paths: ["old.ts", "new.ts"] }));

		// Commit & push partial failure displays both commit notice and push error
		fireEvent.change(screen.getByLabelText("提交"), { target: { value: "feat: rename" } });
		fireEvent.click(screen.getByRole("button", { name: "提交并推送" }));
		await waitFor(() => expect(screen.getByText("已提交 1a2b3c4")).toBeTruthy());
		expect(screen.getByText("rejected by remote")).toBeTruthy();
	});

	it("enforces mutual exclusion between hunk action and file stage, hides hunk action on renamed files, and isolates upload tabs", async () => {
		let resolveHunk!: (v: unknown) => void;
		const postBodies: Array<Record<string, unknown>> = [];
		let abortedUpload = false;
		vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
			if (url.includes("upload=1")) {
				init?.signal?.addEventListener("abort", () => { abortedUpload = true; });
				return Promise.resolve(jsonResponse({ content: "# Uploaded note\n", binary: false, truncated: false, size: 16 }));
			}
			if (init?.method === "POST") {
				const body = JSON.parse(String(init.body));
				postBodies.push(body);
				return new Promise((resolve) => { resolveHunk = resolve; });
			}
			return Promise.resolve(jsonResponse({ patch: "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n", binary: false, truncated: false }));
		}));

		const view = render(
			<FileViewer
				state={{ open: true, active: "a.ts", tabs: [{ path: "a.ts", git: { mode: "worktree", label: "工作区差异" } }] }}
				growth={stubGrowth()}
				cwd="/repo"
				onClose={vi.fn()}
				onSelectTab={vi.fn()}
				onCloseTab={vi.fn()}
				onOpen={vi.fn()}
				onOpenEditor={vi.fn()}
				onReference={vi.fn()}
			/>,
		);
		const hunkBtn = await screen.findByRole("button", { name: "暂存此块 #1" });
		fireEvent.click(hunkBtn);
		// Toolbar "+ 暂存" is disabled and ignored while hunk staging is in flight
		const stageBtn = screen.getByRole("button", { name: "+ 暂存" }) as HTMLButtonElement;
		expect(stageBtn.disabled).toBe(true);
		fireEvent.click(stageBtn);
		expect(postBodies).toHaveLength(1);
		resolveHunk(jsonResponse({ info: { files: [] } }));
		await waitFor(() => expect((screen.getByRole("button", { name: "+ 暂存" }) as HTMLButtonElement).disabled).toBe(false));

		// Renamed file hides hunk checkboxes
		view.rerender(
			<FileViewer
				state={{ open: true, active: "new.ts", tabs: [{ path: "new.ts", from: "old.ts", git: { mode: "staged", label: "暂存区差异" } }] }}
				growth={stubGrowth()}
				cwd="/repo"
				onClose={vi.fn()}
				onSelectTab={vi.fn()}
				onCloseTab={vi.fn()}
				onOpen={vi.fn()}
			/>,
		);
		await screen.findByTestId("split-diff");
		expect(screen.queryByRole("button", { name: /取消暂存此块/ })).toBeNull();

		// Upload tab hides workspace actions (Diff toggle, Open in editor, @reference) and aborts on unmount
		view.rerender(
			<FileViewer
				state={{ open: true, active: "/tmp/agent/web-uploads/doc.md", tabs: [{ path: "/tmp/agent/web-uploads/doc.md", kind: "upload" }] }}
				growth={stubGrowth()}
				cwd="/repo"
				onClose={vi.fn()}
				onSelectTab={vi.fn()}
				onCloseTab={vi.fn()}
				onOpen={vi.fn()}
				onOpenEditor={vi.fn()}
				onReference={vi.fn()}
			/>,
		);
		await screen.findByText("Uploaded note");
		expect(screen.queryByRole("radio", { name: "变更" })).toBeNull();
		expect(screen.queryByTitle(/编辑器/)).toBeNull();
		expect(screen.queryByTitle(/引用/)).toBeNull();
		view.unmount();
		expect(abortedUpload).toBe(true);
	});
});
