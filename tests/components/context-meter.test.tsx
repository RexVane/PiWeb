// @vitest-environment jsdom
/**
 * 上下文圆环弹窗：冷会话也列出 Memory / Skills / Buffer 等能算的分项，并给「现在统计」；
 * 点了之后等新分项（不再是冷的）到来，System Prompt 与工具定义补齐、提示消失。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ContextMeter } from "@/components/ContextMeter";
import type { ContextBreakdown } from "@/lib/types";

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

/** 精度与归一化（#064 调研）：百分比两位小数；分项之和 = 头部真实用量 */
const USAGE_LABEL = "12.00% 上下文估算";

const COLD: ContextBreakdown = { systemPrompt: 0, systemTools: 0, customTools: 0, memory: 1200, skills: 300, compacted: 0, autoCompactBuffer: 16384, cold: true, characters: { systemPrompt: 0, systemTools: 0, customTools: 0, memory: 4800, skills: 1200, compacted: 0 } };
const WARM: ContextBreakdown = { systemPrompt: 2500, systemTools: 4100, customTools: 900, memory: 1200, skills: 310, compacted: 0, autoCompactBuffer: 16384, characters: { systemPrompt: 10000, systemTools: 16400, customTools: 3600, memory: 4800, skills: 1240, compacted: 0 } };
const MESSAGES = [{ role: "user", content: [{ type: "text", text: "hello there, please look at the project" }] }];

const segmentWidth = (bar: HTMLElement, key: string) => Number.parseFloat((bar.querySelector(`[data-segment="${key}"]`) as HTMLElement).style.width);
/** 分段宽度（不含预留那一段） */
const typeWidths = (bar: HTMLElement) => [...bar.querySelectorAll("[data-segment]")].filter((el) => el.getAttribute("data-segment") !== "reserved")
	.map((el) => Number.parseFloat((el as HTMLElement).style.width));

function meter(breakdown: ContextBreakdown, loadFull?: () => unknown) {
	return <ContextMeter percent={12} tokens={24000} contextWindow={200000} source={{ systemChars: 0, messages: MESSAGES, breakdown, loadFull }} />;
}

describe("上下文圆环弹窗", () => {
	it("冷会话列出能算的分项，点「现在统计」后等新分项补齐", async () => {
		const loadFull = vi.fn(async () => ({ success: true }));
		const view = render(meter(COLD, loadFull));
		fireEvent.click(screen.getByTitle(USAGE_LABEL));

		for (const label of ["Memory（AGENTS.md）", "Skills", "Auto-Compact Buffer", "User Messages", "Free Space"]) expect(screen.getByText(label)).toBeTruthy();
		expect(screen.queryByText("System Prompt")).toBeNull();
		expect(screen.getByText(/会话还没启动/)).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: "现在统计" }));
		expect(loadFull).toHaveBeenCalledTimes(1);
		expect((screen.getByRole("button", { name: "统计中…" }) as HTMLButtonElement).disabled).toBe(true);

		view.rerender(meter(WARM, loadFull));
		for (const label of ["System Prompt", "System Tools", "Custom Tools", "Memory（AGENTS.md）", "Skills"]) expect(screen.getByText(label)).toBeTruthy();
		expect(screen.queryByText(/会话还没启动/)).toBeNull();
		expect(screen.queryByRole("button", { name: /统计/ })).toBeNull();
	});

	it("启动失败（例如没配模型）把按钮还回来，可以再点", async () => {
		const loadFull = vi.fn(async () => ({ success: false, error: "no model" }));
		render(meter(COLD, loadFull));
		fireEvent.click(screen.getByTitle(USAGE_LABEL));
		fireEvent.click(screen.getByRole("button", { name: "现在统计" }));
		expect(await screen.findByRole("button", { name: "现在统计" })).toBeTruthy();
	});

	it("没有启动入口（不在会话里）就只列分项，不给按钮", () => {
		render(meter(COLD));
		fireEvent.click(screen.getByTitle(USAGE_LABEL));
		expect(screen.getByText("Skills")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "现在统计" })).toBeNull();
	});

	it("Free Space 使用上下文估算与配置预留;分类保持实际字符数", () => {
		// tokens 24000 / window 200000 / Auto-Compact Buffer 预留 16384
		// → Free = 200000 − 24000 − 16384 = 159616 = 159.62K
		// (头部 + 预留 + Free 精确等于窗口)
		render(meter(WARM));
		fireEvent.click(screen.getByTitle(USAGE_LABEL));
		expect(screen.getByText("~159.62K tok")).toBeTruthy();
		expect(screen.getByText("10.00K 字符")).toBeTruthy();
		expect(screen.getByText("4.80K 字符")).toBeTruthy();
		// #087:说明文字与「估算占比」两行都去掉了,分项列表改当进度条的图例

		// 弹窗正文不再有估算那两行,也没有说明段落
		const popover = screen.getByTestId("context-bar").parentElement as HTMLElement;
		expect(popover.textContent).not.toContain("上下文估算");
		expect(popover.textContent).not.toContain("内容分类");
		expect(popover.textContent).not.toContain("按当前文本统计");
	});

	/**
	 * 手机(390px)上弹窗右下角对齐圆环,而圆环离右边缘只有约 24px:
	 * 固定 w-72(288px)会往左顶出屏幕(实测 390px 下 left=31、344px 下 left=-15)。
	 * 屏幕窄于「弹窗宽 + 两侧留白」时必须自己收缩,否则左侧内容既看不到也滑不到。
	 */
	it("弹窗自己限制宽度,屏幕再窄也不会顶出左边", () => {
		render(meter(WARM));
		fireEvent.click(screen.getByTitle(USAGE_LABEL));
		const popover = screen.getByTestId("context-bar").parentElement as HTMLElement;
		expect(popover.className).toContain("w-72");
		expect(popover.className).toContain("max-w-[calc(100vw-96px)]");
		expect(popover.className).toContain("pw-context-popover");
	});

	/** 进度条 = 整扇窗口：已用那一截按各类字符比例分段（你问的「什么类型占多少」就在条上） */
	it("进度条铺满整扇窗口：分段按字符比例、比例之和等于已用那一截", () => {
		render(meter(WARM));
		fireEvent.click(screen.getByTitle(USAGE_LABEL));
		const bar = screen.getByTestId("context-bar") as HTMLElement;
		// 没有 API 输入时基准退回 SDK 估算：24000 / 200000 = 12%
		expect(typeWidths(bar).reduce((sum, w) => sum + w, 0)).toBeCloseTo(12, 6);
		// 段宽比例 = 字符数比例（API 不给分类 token，只摊比例、不报每类 token 数）
		expect(segmentWidth(bar, "builtin") / segmentWidth(bar, "system")).toBeCloseTo(16400 / 10000, 6);
		// 预留单独一段：16384 / 200000 = 8.192%
		expect(segmentWidth(bar, "reserved")).toBeCloseTo(8.192, 6);
		expect(bar.querySelector('[data-segment="compacted"]')).toBeNull();
	});

	it("有 API 输入时，已用那一截按真实输入铺，不用 SDK 估算", () => {
		// 1000 + 10000 + 734 = 11734 tok → 5.867%（SDK 估算是 12%）
		render(<ContextMeter percent={12} tokens={24000} contextWindow={200000} source={{ systemChars: 0, breakdown: WARM, messages: [...MESSAGES,
			{ role: "assistant", content: [], usage: { input: 1000, cacheRead: 10000, cacheWrite: 734, output: 250 }, stopReason: "stop" },
		] }} />);
		fireEvent.click(screen.getByTitle(USAGE_LABEL));
		expect(typeWidths(screen.getByTestId("context-bar") as HTMLElement).reduce((sum, w) => sum + w, 0)).toBeCloseTo(11734 / 200000 * 100, 6);
	});

	it("API 用量取最近一次有效回复，错误回复和正在生成的回复不能覆盖它", () => {
		render(<ContextMeter percent={12} tokens={24000} contextWindow={200000} source={{ systemChars: 0, breakdown: WARM, messages: [
			{ role: "assistant", content: [], usage: { input: 1234, cacheRead: 10000, cacheWrite: 500, output: 250 }, stopReason: "stop" },
			{ role: "assistant", content: [], usage: { input: 999 }, stopReason: "error" },
			{ role: "assistant", content: [], usage: { input: 888 }, stopReason: "pending" },
		] }} />);
		fireEvent.click(screen.getByTitle(USAGE_LABEL));
		expect(screen.getByText("最近请求输入（API）")).toBeTruthy();
		expect(screen.getByTitle("11734 tok").textContent).toBe("11.73K tok");
	});

	it("压缩卡以上的历史只剩摘要：字符分类和最近输入都从卡片往后算", () => {
		// 消息列表照常显示压缩前的历史；卡片前的用户消息、保留下来的旧回复用量都不能算进当前上下文
		render(<ContextMeter percent={12} tokens={24000} contextWindow={200000} source={{ systemChars: 0, breakdown: WARM, messages: [
			{ role: "user", content: [{ type: "text", text: "x".repeat(5000) }], timestamp: 1 },
			{ role: "assistant", content: [], usage: { input: 150000 }, stopReason: "stop", timestamp: 2 },
			{ role: "summary", summaryKind: "compaction", content: [], timestamp: 10 },
			{ role: "user", content: [{ type: "text", text: "y".repeat(1200) }], timestamp: 3 },
			{ role: "assistant", content: [], usage: { input: 90000 }, stopReason: "stop", timestamp: 4 },
			{ role: "assistant", content: [], usage: { input: 2000 }, stopReason: "stop", timestamp: 11 },
		] }} />);
		fireEvent.click(screen.getByTitle(USAGE_LABEL));
		expect(screen.getByText("1.20K 字符")).toBeTruthy();
		expect(screen.queryByText("6.20K 字符")).toBeNull();
		expect(screen.getByTitle("2000 tok").textContent).toBe("2.00K tok");
	});

	it("压缩后用量未知，不将窗口全部显示成空闲", () => {
		render(<ContextMeter percent={null} tokens={null} contextWindow={200000} source={{ systemChars: 0, messages: [], breakdown: WARM }} />);
		fireEvent.click(screen.getByTitle("上下文用量未知"));
		expect(screen.getByText("Free Space").parentElement?.textContent).toBe("Free Space—");
		expect(screen.queryByText("~183.62K tok")).toBeNull();
	});
});

/** 改上下文窗口（重做 PR #27）：精确数字输入，不用滑块；给内置原值对照，写明是全局配置 */
describe("上下文圆环里改窗口", () => {
	const MODEL = { provider: "anthropic", id: "claude-haiku-4-5" };

	function stubModelsApi(save: (body: Record<string, unknown>) => { status?: number; payload: unknown }) {
		const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body));
			if (body.action === "contextWindowInfo") return { ok: true, status: 200, json: async () => ({ success: true, data: { contextWindow: 200000, builtin: 200000 } }) };
			const { status = 200, payload } = save(body);
			return { ok: status < 400, status, json: async () => payload };
		});
		vi.stubGlobal("fetch", fetchMock);
		return fetchMock;
	}
	const input = () => screen.getByRole("textbox", { name: "上下文窗口" }) as HTMLInputElement;

	it("没有模型就不给修改入口", () => {
		render(meter(WARM));
		fireEvent.click(screen.getByTitle(USAGE_LABEL));
		expect(screen.queryByRole("button", { name: "修改" })).toBeNull();
	});

	it("填精确值保存：给内置原值对照、填大了提醒、说明是全局配置；保存后圆环按新窗口重算", async () => {
		const fetchMock = stubModelsApi((body) => ({ payload: { success: true, data: { contextWindow: body.contextWindow, builtin: 200000 } } }));
		const view = render(<ContextMeter percent={12} tokens={24000} contextWindow={200000} model={MODEL} source={{ systemChars: 0, messages: MESSAGES, breakdown: WARM }} />);
		fireEvent.click(screen.getByTitle(USAGE_LABEL));
		expect(screen.getByText("200,000")).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: "修改" }));
		expect(input().value).toBe("200K");
		expect(await screen.findByText("pi 内置目录：200,000")).toBeTruthy();
		expect(screen.getByText(/全局配置（models.json）/)).toBeTruthy();
		expect(screen.queryByText(/比内置目录大/)).toBeNull();

		fireEvent.change(input(), { target: { value: "1M" } });
		expect(screen.getByText(/比内置目录大/)).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "保存" }));

		await waitFor(() => expect(screen.queryByRole("textbox", { name: "上下文窗口" })).toBeNull());
		expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({ action: "setContextWindow", providerId: "anthropic", modelId: "claude-haiku-4-5", contextWindow: 1000000 });
		// 冷会话等不到用量事件：先用回来的新值重算（24000 / 1000000 = 2.40%）
		expect(screen.getByText("1,000,000")).toBeTruthy();
		expect(screen.getByTitle("2.40% 上下文估算")).toBeTruthy();

		// 快照 / 用量追上来后交还给 props
		view.rerender(<ContextMeter percent={2.4} tokens={24000} contextWindow={1000000} model={MODEL} source={{ systemChars: 0, messages: MESSAGES, breakdown: WARM }} />);
		expect(screen.getByText("1,000,000")).toBeTruthy();
		view.rerender(<ContextMeter percent={20} tokens={24000} contextWindow={120000} model={MODEL} source={{ systemChars: 0, messages: MESSAGES, breakdown: WARM }} />);
		expect(screen.getByText("120,000")).toBeTruthy();
	});

	it("保存后快照还没追上时先显示刚保存的值；props 变成别的值（别处改过）就以 props 为准", async () => {
		stubModelsApi((body) => ({ payload: { success: true, data: { contextWindow: body.contextWindow, builtin: 200000 } } }));
		const meter = (contextWindow: number) => (
			<ContextMeter percent={12} tokens={24000} contextWindow={contextWindow} model={MODEL} source={{ systemChars: 0, messages: MESSAGES, breakdown: WARM }} />
		);
		const view = render(meter(200000));
		fireEvent.click(screen.getByTitle(USAGE_LABEL));
		fireEvent.click(screen.getByRole("button", { name: "修改" }));
		fireEvent.change(input(), { target: { value: "1M" } });
		fireEvent.click(screen.getByRole("button", { name: "保存" }));
		await waitFor(() => expect(screen.queryByRole("textbox", { name: "上下文窗口" })).toBeNull());
		expect(screen.getByText("1,000,000")).toBeTruthy();

		view.rerender(meter(200000));
		expect(screen.getByText("1,000,000")).toBeTruthy();

		view.rerender(meter(150000));
		expect(screen.getByText("150,000")).toBeTruthy();
		expect(screen.queryByText("1,000,000")).toBeNull();
	});

	it("非法输入不能保存；「填入」用内置值；Esc 取消不发请求、不冒泡", async () => {
		const save = vi.fn(() => ({ payload: { success: true, data: { contextWindow: 1, builtin: 200000 } } }));
		const fetchMock = stubModelsApi(save);
		const outer = vi.fn();
		render(<div onKeyDown={outer}><ContextMeter percent={12} tokens={24000} contextWindow={128000} model={MODEL} source={{ systemChars: 0, messages: MESSAGES, breakdown: WARM }} /></div>);
		fireEvent.click(screen.getByTitle(USAGE_LABEL));
		fireEvent.click(screen.getByRole("button", { name: "修改" }));
		await screen.findByText("pi 内置目录：200,000");

		for (const bad of ["", "abc", "0", "-5"]) {
			fireEvent.change(input(), { target: { value: bad } });
			expect((screen.getByRole("button", { name: "保存" }) as HTMLButtonElement).disabled).toBe(true);
			expect(screen.getByText(/填正整数/)).toBeTruthy();
		}
		fireEvent.click(screen.getByRole("button", { name: "填入" }));
		expect(input().value).toBe("200K");

		fireEvent.keyDown(input(), { key: "Escape" });
		expect(screen.queryByRole("textbox", { name: "上下文窗口" })).toBeNull();
		expect(outer).not.toHaveBeenCalled();
		expect(save).not.toHaveBeenCalled();
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("保存失败留在编辑态并显示原因", async () => {
		stubModelsApi(() => ({ status: 409, payload: { success: false, error: "models.json 已被修改，请重新加载后再保存" } }));
		render(<ContextMeter percent={12} tokens={24000} contextWindow={200000} model={MODEL} source={{ systemChars: 0, messages: MESSAGES, breakdown: WARM }} />);
		fireEvent.click(screen.getByTitle(USAGE_LABEL));
		fireEvent.click(screen.getByRole("button", { name: "修改" }));
		fireEvent.keyDown(input(), { key: "Enter" });
		expect((await screen.findByRole("alert")).textContent).toContain("models.json 已被修改");
		expect(input().value).toBe("200K");
		expect(screen.getByTitle("12.00% 上下文估算")).toBeTruthy();
	});
});
