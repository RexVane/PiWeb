// @vitest-environment jsdom
/**
 * 插件/扩展卡片的状态显示。
 *
 * 回归：这里曾经是「头部按 e.disabled 显示已停用，展开区恒定显示已启用的写死徽标」——
 * 同一张卡片自相矛盾（用户截图报的就是它）。现在状态只剩头部一处，且跟着真实值走。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { PluginsSection } from "@/components/SettingsPanel";

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

const EXTENSIONS = [
	{ name: "orca-titlebar-spinner", path: "/home/user/.pi/agent/extensions/orca-titlebar-spinner.ts", disabled: true },
	{ name: "orca-agent-status", path: "/home/user/.pi/agent/extensions/orca-agent-status.ts", disabled: false },
];

function stubPlugins() {
	vi.stubGlobal("fetch", vi.fn(async () => ({
		ok: true,
		json: async () => ({ success: true, data: { packages: [], extensions: EXTENSIONS } }),
	})));
}

const cardOf = (name: string) => {
	const card = screen.getByText(name).closest('[class*="rounded-2xl"]');
	if (!card) throw new Error(`找不到 ${name} 的卡片`);
	return card as HTMLElement;
};

describe("插件卡片的状态显示", () => {
	it("停用的扩展：卡片里只有「已停用」，展开后不会又冒出「已启用」", async () => {
		stubPlugins();
		render(<PluginsSection cwd="/workspace" />);
		const card = await screen.findByText("orca-titlebar-spinner").then(() => cardOf("orca-titlebar-spinner"));
		expect(within(card).getByText("已停用")).toBeTruthy();

		fireEvent.click(within(card).getByText("orca-titlebar-spinner"));
		// 展开区曾写死「已启用」：这里必须一个都没有，且状态文案仍只有一条
		expect(within(card).queryByText("已启用")).toBeNull();
		expect(within(card).getAllByText(/已停用|已启用/)).toHaveLength(1);
	});

	it("启用的扩展显示「已启用」，与停用项各说各的", async () => {
		stubPlugins();
		render(<PluginsSection cwd="/workspace" />);
		await screen.findByText("orca-agent-status");
		const enabled = cardOf("orca-agent-status");
		const disabled = cardOf("orca-titlebar-spinner");
		expect(within(enabled).getByText("已启用")).toBeTruthy();
		expect(within(disabled).getByText("已停用")).toBeTruthy();
		expect(within(enabled).queryByText("已停用")).toBeNull();
	});
});
