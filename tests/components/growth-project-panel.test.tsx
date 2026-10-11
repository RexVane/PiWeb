// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectPanel } from "@/components/ProjectPanel";
import type { GrowthApi, GrowthEntry } from "@/hooks/useGrowth";
import { buildTree } from "@/lib/growth-tree";

const growth: GrowthApi = {
	available: true, loading: false, error: null, rounds: [], selected: null, scope: "round", range: null, changes: [],
	tree: buildTree([], []), filePaths: [], expanded: new Set(), fresh: new Set(),
	selectLatest() {}, select() {}, prev() {}, next() {}, setScope() {}, toggleDir() {}, revealPath() {}, expandAll() {}, collapseAll() {},
	async expandLazy() {}, async refresh() {}, async recordNow() { return null; },
};

const h = (c: string) => c.repeat(40);
const stats = { added: 1, modified: 1, deleted: 0, renamed: 0, add: 12, del: 3 };
const piRound: GrowthEntry = {
	commit: h("b"), parent: h("a"), tree: h("2"), parentTree: h("1"), ts: new Date(2026, 9, 7, 14, 32).getTime(), kind: "round", title: "把保存按钮改成红色",
	session: "s.jsonl", promptIds: ["u1"], status: "done", n: 1, stats,
	changes: [{ status: "M", path: "src/Settings.tsx", add: 8, del: 2 }, { status: "A", path: "src/SaveButton.tsx", add: 4, del: 1 }],
};
const userEdit: GrowthEntry = { ...piRound, commit: h("c"), parent: h("b"), tree: h("3"), parentTree: h("2"), kind: "user", title: "", promptIds: [], n: null };

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("ProjectPanel rounds", () => {
	it("summarizes the selected round and links back to the chat", () => {
		vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));
		const onJumpToChat = vi.fn();
		const select = vi.fn();
		render(
			<ProjectPanel
				growth={{ ...growth, rounds: [piRound, userEdit], selected: piRound, changes: piRound.changes, select }}
				workspaceName="workspace" cwd="/workspace" hasSession running onOpenFile={vi.fn()} onClose={vi.fn()} onError={vi.fn()} onJumpToChat={onJumpToChat}
			/>,
		);
		const summary = screen.getByTestId("growth-round-summary");
		expect(summary.textContent).toMatch(/(第 1 轮|Round 1) · 把保存按钮改成红色/);
		expect(summary.textContent).toMatch(/14:32/);
		expect(summary.textContent).toMatch(/(2 个文件|2 files)\s*\+12\s*−3/);
		fireEvent.click(screen.getByRole("button", { name: /在对话里看|Show in chat/ }));
		expect(onJumpToChat).toHaveBeenCalledWith("u1");

		const bars = screen.getByTestId("growth-timeline").querySelectorAll(".pw-tl-bar");
		expect([...bars].map((bar) => bar.getAttribute("data-kind") ?? (bar.hasAttribute("data-running") ? "running" : ""))).toEqual(["round", "user", "running"]);
		expect(bars[0].hasAttribute("data-active")).toBe(true);
		fireEvent.click(bars[1]);
		expect(select).toHaveBeenCalledWith(h("c"));
		expect(screen.getByTestId("growth-timeline").textContent).toMatch(/第 1\/1 轮|Round 1\/1/);
		// 底部不再有「跟随 / 跟随中」开关
		expect(screen.queryByRole("button", { name: /跟随|Follow/ })).toBeNull();
	});

	it("opens the round picker from the counter and jumps to a clamped round number", () => {
		vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));
		const select = vi.fn();
		const round2: GrowthEntry = { ...piRound, commit: h("d"), parent: h("c"), tree: h("4"), parentTree: h("3"), n: 2, title: "第二轮" };
		render(
			<ProjectPanel
				growth={{ ...growth, rounds: [piRound, round2], selected: round2, changes: piRound.changes, select }}
				workspaceName="workspace" cwd="/workspace" hasSession onOpenFile={vi.fn()} onClose={vi.fn()} onError={vi.fn()}
			/>,
		);
		// 计数本身就是打开列表的按钮(不是跟随开关)
		fireEvent.click(screen.getByTestId("growth-round-picker"));
		const list = screen.getByTestId("growth-round-list");
		// 每行 = 轮号 + 提问首行 + 时间
		expect(list.textContent).toContain("把保存按钮改成红色");
		expect(list.textContent).toContain("14:32");
		fireEvent.click(within(list).getByText(/第二轮/));
		expect(select).toHaveBeenCalledWith(h("d"));
		expect(screen.queryByTestId("growth-round-list")).toBeNull();

		// 「输入轮号」:越界夹到有效范围
		select.mockClear();
		fireEvent.click(screen.getByTestId("growth-round-picker"));
		fireEvent.click(screen.getByTestId("growth-round-jump"));
		const input = screen.getByTestId("growth-round-input") as HTMLInputElement;
		fireEvent.change(input, { target: { value: "99" } });
		fireEvent.keyDown(input, { key: "Enter" });
		expect(select).toHaveBeenCalledWith(h("d"));

		// 非法输入不跳
		select.mockClear();
		fireEvent.click(screen.getByTestId("growth-round-picker"));
		fireEvent.click(screen.getByTestId("growth-round-jump"));
		const input2 = screen.getByTestId("growth-round-input") as HTMLInputElement;
		fireEvent.change(input2, { target: { value: "abc" } });
		fireEvent.keyDown(input2, { key: "Enter" });
		expect(select).not.toHaveBeenCalled();
	});

	it("closes the round picker on Escape", () => {
		vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));
		render(
			<ProjectPanel
				growth={{ ...growth, rounds: [piRound], selected: piRound, changes: piRound.changes }}
				workspaceName="workspace" cwd="/workspace" hasSession onOpenFile={vi.fn()} onClose={vi.fn()} onError={vi.fn()}
			/>,
		);
		fireEvent.click(screen.getByTestId("growth-round-picker"));
		expect(screen.getByTestId("growth-round-list")).toBeTruthy();
		fireEvent.keyDown(document, { key: "Escape" });
		expect(screen.queryByTestId("growth-round-list")).toBeNull();
	});

	it("shows a notice when recording finds no new changes", async () => {
		vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));
		const recordNow = vi.fn(async () => null);
		render(<ProjectPanel growth={{ ...growth, recordNow }} workspaceName="workspace" cwd="/workspace" hasSession onOpenFile={vi.fn()} onClose={vi.fn()} onError={vi.fn()} />);
		await act(async () => { fireEvent.click(screen.getByTitle(/立即记录|Record now/)); });
		expect(recordNow).toHaveBeenCalledTimes(1);
		expect(screen.getByText(/没有新的改动|No new changes/)).toBeTruthy();
	});
});

describe("ProjectPanel Git unknown state", () => {
	it.each(["status", "request"])("does not show clean or commit controls after a %s failure", async (kind) => {
		vi.useFakeTimers();
		const info = { available: true, isRepo: true, root: "/workspace", branch: "main", upstream: null, ahead: 0, behind: 0, detached: false, files: [], commits: [], statusError: "index file corrupt" };
		vi.stubGlobal("fetch", kind === "status"
			? vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true, data: info }) })
			: vi.fn().mockRejectedValue(new Error("request failed")));
		render(<ProjectPanel growth={growth} workspaceName="workspace" cwd="/workspace" hasSession={false} onOpenFile={vi.fn()} onClose={vi.fn()} onError={vi.fn()} onAskCommit={vi.fn()} />);
		await act(async () => { await vi.advanceTimersByTimeAsync(300); });
		const error = screen.getByTestId("growth-git-error");
		expect(error.textContent).toMatch(/Git 状态读取失败|Git status unavailable/);
		expect(error.getAttribute("title")).toBe(kind === "status" ? "index file corrupt" : "request failed");
		expect(screen.queryByText(/工作区干净|Working tree clean/)).toBeNull();
		expect(screen.queryByRole("button", { name: /让 pi 提交|Ask pi to commit/ })).toBeNull();
	});
});

describe("GrowthConsentDialog", () => {
	it("explains a nested repository, remembers only explicit answers, and Esc just closes", async () => {
		const { GrowthConsentDialog } = await import("@/components/ProjectPanel");
		const onAnswer = vi.fn();
		const request = { cwd: "/outer/sub", reason: "nested" as const, parent: "/outer" };
		const { rerender } = render(<GrowthConsentDialog request={request} onAnswer={onAnswer} />);
		const dialog = screen.getByTestId("growth-consent-dialog");
		expect(dialog.textContent).toContain("/outer/sub");
		expect(dialog.textContent).toContain("/outer");
		fireEvent.keyDown(dialog, { key: "Escape" });
		expect(screen.queryByTestId("growth-consent-dialog")).toBeNull();
		expect(onAnswer).not.toHaveBeenCalled();
		// 换了工作区的请求要重新弹出
		rerender(<GrowthConsentDialog request={{ cwd: "/plain", reason: "not-git" }} onAnswer={onAnswer} />);
		const buttons = screen.getByTestId("growth-consent-dialog").querySelectorAll("button");
		fireEvent.click(buttons[buttons.length - 1]);
		expect(onAnswer).toHaveBeenCalledWith(true);
		fireEvent.click(buttons[0]);
		expect(onAnswer).toHaveBeenLastCalledWith(false);
	});
});
