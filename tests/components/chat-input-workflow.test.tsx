// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ChatInput } from "@/components/ChatInput";
import type { WorkflowMode, WorkflowState } from "@/lib/types";

afterEach(cleanup);

function renderWorkflow(workflow: WorkflowState, isStreaming = false) {
	const onWorkflowModeChange = vi.fn<(mode: WorkflowMode) => void | Promise<{ success?: boolean } | void>>();
	const onApprovePlan = vi.fn();
	render(<ChatInput
		isStreaming={isStreaming}
		model={{ provider: "test", id: "model", name: "Model" }}
		contextPercent={null}
		contextTokens={null}
		contextWindow={null}
		thinkingLevels={[]}
		models={[]}
		providerNames={{}}
		authByProvider={{}}
		queue={{ steering: [], followUp: [] }}
		workflow={workflow}
		onWorkflowModeChange={onWorkflowModeChange}
		onApprovePlan={onApprovePlan}
		onSend={vi.fn(async () => ({ success: true }))}
		onSteer={vi.fn(async () => ({ success: true }))}
		onAbort={vi.fn()}
		onSelectModel={vi.fn()}
		onSelectLevel={vi.fn()}
	/>);
	return { onWorkflowModeChange, onApprovePlan };
}

describe("ChatInput workflows", () => {
	it("keeps a short draft compact and expands for longer or multiline text", () => {
		renderWorkflow({ mode: "agent", planStatus: "idle", goal: "" });
		const composer = screen.getByTestId("composer");
		const textarea = screen.getByRole("textbox");
		expect(composer.hasAttribute("data-expanded")).toBe(false);
		fireEvent.change(textarea, { target: { value: "a".repeat(57) } });
		expect(composer.getAttribute("data-expanded")).toBe("true");
		fireEvent.change(textarea, { target: { value: "short" } });
		expect(composer.hasAttribute("data-expanded")).toBe(false);
		fireEvent.change(textarea, { target: { value: "line one\nline two" } });
		expect(composer.getAttribute("data-expanded")).toBe("true");
	});

	it("offers mode changes without changing the user's draft", () => {
		const { onWorkflowModeChange } = renderWorkflow({ mode: "agent", planStatus: "idle", goal: "" });
		const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
		fireEvent.change(textarea, { target: { value: "Keep this draft" } });
		fireEvent.click(screen.getByRole("button", { name: /选择工作模式: Agent/ }));
		fireEvent.click(screen.getByRole("menuitemradio", { name: /Plan/ }));
		expect(onWorkflowModeChange).toHaveBeenCalledWith("plan");
		expect(textarea.value).toBe("Keep this draft");
	});

	it("shows a mode immediately and rolls it back when the command fails", async () => {
		let complete!: (result: { success: boolean }) => void;
		const { onWorkflowModeChange } = renderWorkflow({ mode: "agent", planStatus: "idle", goal: "" });
		onWorkflowModeChange.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
		fireEvent.click(screen.getByRole("button", { name: /Agent/ }));
		fireEvent.click(screen.getByRole("menuitemradio", { name: /Plan/ }));
		expect(screen.getAllByRole("button", { name: /Plan/ })).toHaveLength(2);
		expect(screen.getByTestId("composer").querySelector(".pw-composer")?.getAttribute("data-mode")).toBe("plan");
		await act(async () => complete({ success: false }));
		expect(screen.getByTestId("composer").querySelector(".pw-composer")?.getAttribute("data-mode")).toBe("agent");
	});

	it("keeps the latest mode visible while serializing quick changes", async () => {
		let finishFirst!: (result: { success: boolean }) => void;
		const { onWorkflowModeChange } = renderWorkflow({ mode: "agent", planStatus: "idle", goal: "" });
		onWorkflowModeChange.mockImplementationOnce(() => new Promise((resolve) => { finishFirst = resolve; }));
		onWorkflowModeChange.mockResolvedValue({ success: true });
		fireEvent.click(screen.getByRole("button", { name: /Agent/ }));
		fireEvent.click(screen.getByRole("menuitemradio", { name: /Plan/ }));
		fireEvent.click(screen.getByRole("button", { name: /选择工作模式: Plan/ }));
		fireEvent.click(screen.getByRole("menuitemradio", { name: /Goal/ }));
		expect(onWorkflowModeChange).toHaveBeenCalledTimes(1);
		expect(screen.getByTestId("composer").querySelector(".pw-composer")?.getAttribute("data-mode")).toBe("goal");
		await act(async () => finishFirst({ success: true }));
		expect(onWorkflowModeChange).toHaveBeenNthCalledWith(2, "goal");
		expect(screen.getByTestId("composer").querySelector(".pw-composer")?.getAttribute("data-mode")).toBe("goal");
	});

	it("marks the active mode and closes the menu with Escape", () => {
		renderWorkflow({ mode: "plan", planStatus: "idle", goal: "" });
		expect((screen.getByRole("textbox") as HTMLTextAreaElement).placeholder).toBe("规划改动…");
		fireEvent.click(screen.getByRole("button", { name: /选择工作模式: Plan/ }));
		expect(screen.getByRole("menuitemradio", { name: /Plan/ }).getAttribute("aria-checked")).toBe("true");
		fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
		expect(screen.queryByRole("menu")).toBeNull();
	});

	it("closes the mode menu from its trigger and before opening the model menu", () => {
		renderWorkflow({ mode: "agent", planStatus: "idle", goal: "" });
		const trigger = screen.getByRole("button", { name: /选择工作模式: Agent/ });
		fireEvent.click(trigger);
		fireEvent.keyDown(trigger, { key: "Escape" });
		expect(screen.queryByRole("menu")).toBeNull();

		fireEvent.click(trigger);
		const model = screen.getByRole("button", { name: /test\/Model/ });
		fireEvent.pointerDown(model);
		fireEvent.click(model);
		expect(screen.getAllByRole("menu")).toHaveLength(1);
		expect(screen.queryByRole("menuitemradio", { name: /Plan/ })).toBeNull();
	});

	it("shows a removable selected-mode tag", () => {
		const { onWorkflowModeChange } = renderWorkflow({ mode: "goal", planStatus: "idle", goal: "Fix tests" });
		expect((screen.getByRole("textbox") as HTMLTextAreaElement).placeholder).toBe("描述要达成的目标…");
		fireEvent.click(screen.getByRole("button", { name: /退出工作模式: Goal/ }));
		expect(onWorkflowModeChange).toHaveBeenCalledWith("agent");
	});

	it("shows an explicit approval action only for a ready plan", () => {
		const { onApprovePlan } = renderWorkflow({ mode: "plan", planStatus: "ready", goal: "" });
		fireEvent.click(screen.getByRole("button", { name: "执行方案" }));
		expect(onApprovePlan).toHaveBeenCalledOnce();
	});

	it("does not allow switching modes while streaming", () => {
		renderWorkflow({ mode: "goal", planStatus: "idle", goal: "Fix tests" }, true);
		expect((screen.getByRole("button", { name: /选择工作模式: Goal/ }) as HTMLButtonElement).disabled).toBe(true);
	});

	it("focuses the composer to refine a ready plan", () => {
		renderWorkflow({ mode: "plan", planStatus: "ready", goal: "" });
		expect(screen.getByText("确认后开始修改代码并验证结果")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "调整方案" }));
		expect(document.activeElement).toBe(screen.getByRole("textbox"));
	});

	it("prevents duplicate approval while the request is pending", async () => {
		let finish!: (result: { success: boolean }) => void;
		const { onApprovePlan } = renderWorkflow({ mode: "plan", planStatus: "ready", goal: "" });
		onApprovePlan.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
		fireEvent.click(screen.getByRole("button", { name: "执行方案" }));
		const pending = screen.getByRole("button", { name: "正在启动…" }) as HTMLButtonElement;
		expect(pending.disabled).toBe(true);
		fireEvent.click(pending);
		expect(onApprovePlan).toHaveBeenCalledOnce();
		await act(async () => finish({ success: true }));
		expect((screen.getByRole("button", { name: "执行方案" }) as HTMLButtonElement).disabled).toBe(false);
	});

	it("shows an approval error in place and allows a retry", async () => {
		const { onApprovePlan } = renderWorkflow({ mode: "plan", planStatus: "ready", goal: "" });
		onApprovePlan.mockResolvedValueOnce({ success: false, error: "request failed" }).mockResolvedValueOnce({ success: true });
		await act(async () => fireEvent.click(screen.getByRole("button", { name: "执行方案" })));
		expect(screen.getByRole("alert").textContent).toBe("request failed");
		await act(async () => fireEvent.click(screen.getByRole("button", { name: "执行方案" })));
		expect(onApprovePlan).toHaveBeenCalledTimes(2);
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("keeps the current goal in one compact line", () => {
		renderWorkflow({ mode: "goal", planStatus: "idle", goal: "Fix tests and verify the release" });
		expect(screen.getByText("当前目标")).toBeTruthy();
		expect(screen.getByText("Fix tests and verify the release")).toBeTruthy();
	});
});
