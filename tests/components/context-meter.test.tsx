// @vitest-environment jsdom
/**
 * 上下文圆环弹窗：冷会话也列出 Memory / Skills / Buffer 等能算的分项，并给「现在统计」；
 * 点了之后等新分项（不再是冷的）到来，System Prompt 与工具定义补齐、提示消失。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ContextMeter } from "@/components/ContextMeter";
import type { ContextBreakdown } from "@/lib/types";

afterEach(cleanup);

/** 精度与归一化（#064 调研）：百分比两位小数；分项之和 = 头部真实用量 */
const USAGE_LABEL = "12.00% 上下文估算";

const COLD: ContextBreakdown = { systemPrompt: 0, systemTools: 0, customTools: 0, memory: 1200, skills: 300, compacted: 0, autoCompactBuffer: 16384, cold: true, characters: { systemPrompt: 0, systemTools: 0, customTools: 0, memory: 4800, skills: 1200, compacted: 0 } };
const WARM: ContextBreakdown = { systemPrompt: 2500, systemTools: 4100, customTools: 900, memory: 1200, skills: 310, compacted: 0, autoCompactBuffer: 16384, characters: { systemPrompt: 10000, systemTools: 16400, customTools: 3600, memory: 4800, skills: 1240, compacted: 0 } };
const MESSAGES = [{ role: "user", content: [{ type: "text", text: "hello there, please look at the project" }] }];

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

	it("Free Space 使用上下文估算与配置预留；分类保持实际字符数", () => {
		// tokens 24000 / window 200000 / Auto-Compact Buffer 预留 16384
		// → Free = 200000 − 24000 − 16384 = 159616 = 159.62K
		// （头部 + 预留 + Free 精确等于窗口）
		render(meter(WARM));
		fireEvent.click(screen.getByTitle(USAGE_LABEL));
		expect(screen.getByText("~159.62K tok")).toBeTruthy();
		expect(screen.getByText("10.00K 字符")).toBeTruthy();
		expect(screen.getByText("4.80K 字符")).toBeTruthy();
		expect(screen.getByText("内容分类（字符数）")).toBeTruthy();
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

	it("压缩后用量未知，不将窗口全部显示成空闲", () => {
		render(<ContextMeter percent={null} tokens={null} contextWindow={200000} source={{ systemChars: 0, messages: [], breakdown: WARM }} />);
		fireEvent.click(screen.getByTitle("上下文用量未知"));
		expect(screen.getByText("Free Space").parentElement?.textContent).toBe("Free Space—");
		expect(screen.queryByText("~183.62K tok")).toBeNull();
	});
});
