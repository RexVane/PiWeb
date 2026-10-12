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
const USAGE_LABEL = "12.00% 上下文已用";

const COLD: ContextBreakdown = { systemPrompt: 0, systemTools: 0, customTools: 0, memory: 1200, skills: 300, compacted: 0, autoCompactBuffer: 16384, cold: true };
const WARM: ContextBreakdown = { systemPrompt: 2500, systemTools: 4100, customTools: 900, memory: 1200, skills: 310, compacted: 0, autoCompactBuffer: 16384 };
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

	it("分项按真实用量归一：Free = 窗口 − 真实用量 − 预留（旧实现用分项估算之和，两者对不上）", () => {
		// tokens 24000 / window 200000 / Auto-Compact Buffer 预留 16384
		// → Free = 200000 − 24000 − 16384 = 159616 = 159.62K
		// （头部 + 预留 + Free 精确等于窗口）
		render(meter(WARM));
		fireEvent.click(screen.getByTitle(USAGE_LABEL));
		expect(screen.getByText("~159.62K")).toBeTruthy();
	});
});
