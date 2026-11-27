// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectPanel, roundTitle } from "@/components/ProjectPanel";
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
	it("marks shared edits and preserves missing chat round numbers", () => {
		vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));
		const shared: GrowthEntry = { ...piRound, roundNumber: 3, n: 3, attribution: "shared", concurrentSessions: ["a.jsonl", "b.jsonl"] };
		render(<ProjectPanel growth={{ ...growth, rounds: [shared], selected: shared, changes: shared.changes }} workspaceName="workspace" cwd="/workspace" hasSession onOpenFile={vi.fn()} onClose={vi.fn()} onError={vi.fn()} />);
		expect(screen.getByTestId("growth-round-summary").textContent).toContain("第 3 轮");
		expect(screen.getByTestId("growth-shared-attribution").textContent).toContain("a.jsonl, b.jsonl");
		expect(screen.getByTestId("growth-round-picker").textContent).toContain("第 3/3 轮");
		expect(screen.getByTestId("growth-timeline").textContent).toContain("缺号");
		expect(screen.queryByText(/2000 条历史或 1 GiB/)).toBeNull();
	});
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

	it("shows rounds recorded before the skill-title fix as /skill:name", () => {
		const t = { growthRoundLabel: "第 {n} 轮", growthKindUser: "你的修改" };
		expect(roundTitle({ ...piRound, title: '<skill name="pdf-tools" location="/x/pdf-tools/SKILL.md">' }, t)).toBe("第 1 轮 · /skill:pdf-tools");
		expect(roundTitle(piRound, t)).toBe("第 1 轮 · 把保存按钮改成红色");
	});

	it("uses complete round stats while the changed-file list is truncated or loading", () => {
		vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));
		render(<ProjectPanel growth={{ ...growth, selected: { ...piRound, truncated: true }, changes: [], changesReady: false }} workspaceName="workspace" cwd="/workspace" hasSession onOpenFile={vi.fn()} onClose={vi.fn()} onError={vi.fn()} />);
		expect(screen.getByTestId("growth-round-summary").textContent).toMatch(/2 个文件\s*\+12\s*−3/);
	});
	it("shows unknown instead of zero until the session diff has loaded", () => {
		vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));
		render(<ProjectPanel growth={{ ...growth, selected: piRound, scope: "session", changesReady: false }} workspaceName="workspace" cwd="/workspace" hasSession onOpenFile={vi.fn()} onClose={vi.fn()} onError={vi.fn()} />);
		const text = screen.getByTestId("growth-round-summary").textContent;
		expect(text).toContain("—");
		expect(text).not.toContain("+0");
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

	it("closes the round list when the counter is pressed again", () => {
		// 回归：ref 只包着列表，按计数按钮的 mousedown 先关掉列表，紧跟的 click 又打开，再点一下关不掉
		vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));
		render(<ProjectPanel growth={{ ...growth, rounds: [piRound], selected: piRound, changes: piRound.changes }} workspaceName="workspace" cwd="/workspace" hasSession onOpenFile={vi.fn()} onClose={vi.fn()} onError={vi.fn()} />);
		const picker = screen.getByTestId("growth-round-picker");
		const press = () => { fireEvent.mouseDown(picker); fireEvent.click(picker); };
		press();
		expect(screen.getByTestId("growth-round-list")).toBeTruthy();
		press();
		expect(screen.queryByTestId("growth-round-list")).toBeNull();
		press();
		fireEvent.mouseDown(document.body);
		expect(screen.queryByTestId("growth-round-list")).toBeNull();
	});

	it("exposes every round bar and the prev/next buttons to screen readers", () => {
		vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));
		const round2: GrowthEntry = { ...piRound, commit: h("d"), parent: h("c"), tree: h("4"), parentTree: h("3"), n: 2, title: "第二轮" };
		render(
			<ProjectPanel
				growth={{ ...growth, rounds: [piRound, round2, userEdit], selected: round2, changes: piRound.changes }}
				workspaceName="workspace" cwd="/workspace" hasSession onOpenFile={vi.fn()} onClose={vi.fn()} onError={vi.fn()}
			/>,
		);
		// 柱子:可访问名称跟着选中轮的标题走(title 不参与可访问名称计算,必须另给 aria-label)
		const bars = [...screen.getByTestId("growth-timeline").querySelectorAll<HTMLElement>(".pw-tl-bar")];
		expect(bars.length).toBeGreaterThanOrEqual(3);
		expect(bars[0].getAttribute("aria-label")).toContain("把保存按钮改成红色");
		expect(bars[2].getAttribute("aria-label")).toMatch(/你的修改|Your change/);
		// 前后轮按钮也要能读出来
		expect(screen.getByRole("button", { name: /上一轮|Previous round/ })).toBeTruthy();
		expect(screen.getByRole("button", { name: /下一轮|Next round/ })).toBeTruthy();
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

it("loads growth records without requesting another working-tree summary in the drawer", async () => {
	const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true, data: { consent: true } }) });
	vi.stubGlobal("fetch", fetchMock);
	render(<ProjectPanel growth={growth} workspaceName="workspace" cwd="/workspace" hasSession onOpenFile={vi.fn()} onClose={vi.fn()} onError={vi.fn()} />);
	expect(await screen.findByRole("button", { name: /已启用|Enabled/ })).toBeTruthy();
	expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/git?"))).toBe(false);
	expect(screen.queryByRole("button", { name: /Git 详情|Git details/i })).toBeNull();
});

describe("ProjectPanel recording switch", () => {
	it("defaults to enabled and stops or resumes recording without confirmation", async () => {
		const saved: unknown[] = [];
		vi.stubGlobal("fetch", vi.fn((url: string, options?: RequestInit) => {
			if (url.startsWith("/api/git")) return new Promise(() => {});
			if (options?.method === "POST") {
				saved.push(JSON.parse(String(options.body)));
				return Promise.resolve({ ok: true, json: async () => ({ success: true }) });
			}
			return Promise.resolve({ ok: true, json: async () => ({ success: true, data: { consent: null } }) });
		}));
		render(<ProjectPanel growth={growth} workspaceName="workspace" cwd="/workspace" hasSession onOpenFile={vi.fn()} onClose={vi.fn()} onError={vi.fn()} />);
		const enabled = await screen.findByRole("button", { name: /已启用|^Enabled$/ });
		expect(enabled.getAttribute("aria-pressed")).toBe("true");
		expect(saved).toEqual([]);
		await act(async () => { fireEvent.click(enabled); });
		const disabled = screen.getByRole("button", { name: /已停用|^Disabled$/ });
		expect(disabled.getAttribute("aria-pressed")).toBe("false");
		await act(async () => { fireEvent.click(disabled); });
		expect(screen.getByRole("button", { name: /已启用|^Enabled$/ })).toBeTruthy();
		expect(saved).toEqual([
			{ action: "setRecording", cwd: "/workspace", allow: false },
			{ action: "setRecording", cwd: "/workspace", allow: true },
		]);
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(screen.queryByRole("alertdialog")).toBeNull();
		expect(screen.queryByText(/2000 条历史或 1 GiB/)).toBeNull();
	});

	it("preserves an existing disabled choice", async () => {
		vi.stubGlobal("fetch", vi.fn((url: string) => (url.startsWith("/api/git") ? new Promise(() => {}) : Promise.resolve({ ok: true, json: async () => ({ success: true, data: { consent: false } }) }))));
		render(<ProjectPanel growth={growth} workspaceName="workspace" cwd="/workspace" hasSession onOpenFile={vi.fn()} onClose={vi.fn()} onError={vi.fn()} />);
		expect((await screen.findByRole("button", { name: /已停用|^Disabled$/ })).getAttribute("aria-pressed")).toBe("false");
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("does not offer a misleading off switch before its setting has loaded", () => {
		const fetchMock = vi.fn().mockReturnValue(new Promise(() => {}));
		vi.stubGlobal("fetch", fetchMock);
		render(<ProjectPanel growth={growth} workspaceName="workspace" cwd="/workspace" hasSession onOpenFile={vi.fn()} onClose={vi.fn()} onError={vi.fn()} />);
		const pending = screen.getByRole("button", { name: "…" }) as HTMLButtonElement;
		expect(pending.disabled).toBe(true);
		fireEvent.click(pending);
		expect(fetchMock).toHaveBeenCalledOnce();
		expect(screen.queryByRole("button", { name: /已停用|^Disabled$/ })).toBeNull();
	});
});

describe("轮次列表：区分有没有改动（方案 1）", () => {
	it("有改动的显示 +N −M，没改动的整行降对比度，选中的那行不灰", () => {
		vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));
		const select = vi.fn();
		const changed: GrowthEntry = { ...piRound, n: 3 };
		// 空跑的一轮：只在对话里说了话，没动过文件
		const empty: GrowthEntry = { ...piRound, commit: h("e"), parent: h("d"), tree: h("5"), parentTree: h("4"), n: 4, title: "空跑一轮", changes: [], stats: { added: 0, modified: 0, deleted: 0, renamed: 0, add: 0, del: 0 } };
		render(
			<ProjectPanel
				growth={{ ...growth, rounds: [changed, empty], selected: changed, changes: changed.changes, select }}
				workspaceName="workspace" cwd="/workspace" hasSession onOpenFile={vi.fn()} onClose={vi.fn()} onError={vi.fn()}
			/>,
		);
		fireEvent.click(screen.getByTestId("growth-round-picker"));
		const rows = [...screen.getByTestId("growth-round-list").querySelectorAll("[role=option]")];
		const changedRow = rows.find((row) => row.textContent?.includes("把保存按钮改成红色"))!;
		const emptyRow = rows.find((row) => row.textContent?.includes("空跑一轮"))!;
		// 有改动：正常亮度 + 改动量（fixture 里是 +12 −3）
		expect(changedRow.getAttribute("style") ?? "").not.toContain("opacity");
		expect(changedRow.textContent).toContain("+12");
		expect(changedRow.textContent).toContain("−3");
		// 没改动：整行降对比度，且不显示改动量
		expect(emptyRow.getAttribute("style")).toContain("opacity: 0.45");
		expect(emptyRow.textContent).not.toContain("+");
		// 列表还开着，直接点空跑那行也能选（选中后由调用方换成 selected，不再灰）
		fireEvent.click(emptyRow);
		expect(select).toHaveBeenCalledWith(h("e"));
	});
});
