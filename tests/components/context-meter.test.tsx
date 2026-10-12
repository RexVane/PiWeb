// @vitest-environment jsdom
/**
 * 上下文圆环里的「窗口滑块」：拖动改当前模型的 contextWindow，POST /api/models 的 setContextWindow，
 * 并乐观显示新值（服务端换绑后由用量事件接管）。没有当前模型时不显示滑块。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ContextMeter } from "@/components/ContextMeter";

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

function okResponse() {
	return { ok: true, status: 200, json: async () => ({ success: true }) };
}

function renderMeter(overrides: Record<string, unknown> = {}) {
	return render(
		<ContextMeter
			percent={10}
			tokens={12800}
			contextWindow={128000}
			model={{ provider: "openai", id: "gpt-5" }}
			{...overrides}
		/>,
	);
}

describe("context meter window slider", () => {
	it("renders the slider and posts the new window to /api/models", async () => {
		const fetchMock = vi.fn(async () => okResponse());
		vi.stubGlobal("fetch", fetchMock);
		const { container } = renderMeter();

		// 打开弹窗
		fireEvent.click(container.querySelector(".icon-btn")!);
		const slider = (await screen.findByLabelText("上下文窗口")) as HTMLInputElement;
		expect(slider.value).toBeDefined();

		// 拖到最大 → 2M，乐观显示 + 去抖后 POST
		fireEvent.change(slider, { target: { value: "100" } });
		expect(container.textContent).toContain("2M");

		await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1), { timeout: 3000 });
		const [url, options] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe("/api/models");
		expect(JSON.parse(String(options.body))).toEqual({
			action: "setContextWindow",
			providerId: "openai",
			modelId: "gpt-5",
			contextWindow: 2000000,
		});
	});

	it("does not render the slider without a current model", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => okResponse()));
		const { container } = renderMeter({ model: null });
		fireEvent.click(container.querySelector(".icon-btn")!);
		await waitFor(() => expect(container.querySelector(".popover")).toBeTruthy());
		expect(screen.queryByLabelText("上下文窗口")).toBeNull();
	});
});
