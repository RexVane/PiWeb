// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ModelSelector } from "@/components/ModelSelector";

afterEach(cleanup);

it("shows the model picker prompt instead of Pi's unknown placeholder", () => {
	render(
		<ModelSelector
			model={{ provider: "unknown", id: "unknown", name: "unknown" }}
			thinkingLevels={[]}
			models={[]}
			providerNames={{}}
			authByProvider={{}}
			onSelectModel={vi.fn()}
			onSelectLevel={vi.fn()}
		/>,
	);
	expect(screen.getByRole("button", { name: /选择模型|Select model/ })).toBeTruthy();
	expect(screen.queryByText("unknown")).toBeNull();
});

it("separates a failed model request from an empty catalog and allows retry", () => {
	const retry = vi.fn();
	render(
		<ModelSelector
			thinkingLevels={[]}
			models={[]}
			modelLoadError="network unavailable"
			onRetryModels={retry}
			providerNames={{}}
			authByProvider={{}}
			onSelectModel={vi.fn()}
			onSelectLevel={vi.fn()}
		/>,
	);
	fireEvent.click(screen.getByRole("button", { name: /选择模型|Select model/ }));
	expect(screen.getByRole("alert").textContent).toMatch(/加载失败|Could not load/);
	expect(screen.queryByText(/没有可用的模型|No models available/)).toBeNull();
	fireEvent.click(screen.getByRole("button", { name: /重试|Retry/ }));
	expect(retry).toHaveBeenCalledOnce();
});
