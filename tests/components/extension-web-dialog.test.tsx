// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ExtensionDialogHost } from "@/components/ExtensionUI";
import type { ExtensionDialog } from "@/hooks/usePiWeb";

afterEach(() => cleanup());

const webDialog = (overrides: Partial<ExtensionDialog>): ExtensionDialog => ({
	id: "d1",
	method: "web",
	title: "待办",
	ts: Date.now(),
	...overrides,
});

describe("extension web UI dialog", () => {
	it("renders a box tree with text, progress and a clickable list", () => {
		const onAnswer = vi.fn();
		render(
			<ExtensionDialogHost
				dialog={webDialog({
					tree: {
						type: "box",
						direction: "column",
						children: [
							{ type: "text", text: "待办 1/2", tone: "accent" },
							{ type: "progress", value: 0.5, label: "完成度" },
							{ type: "list", selected: 0, items: [
								{ label: "写测试", description: "已完成", action: "toggle:1" },
								{ label: "改文档", action: "toggle:2" },
							]},
						],
					},
				})}
				onAnswer={onAnswer}
			/>,
		);

		expect(screen.getByText("待办 1/2")).toBeTruthy();
		expect(screen.getByText("50%")).toBeTruthy();
		fireEvent.click(screen.getByRole("option", { name: /改文档/ }));
		expect(onAnswer).toHaveBeenCalledWith("d1", { value: JSON.stringify({ action: "toggle:2" }) });
	});

	it("renders a table and reports form values on submit", () => {
		const onAnswer = vi.fn();
		render(
			<ExtensionDialogHost
				dialog={webDialog({
					title: "看板",
					tree: {
						type: "box",
						children: [
							{ type: "table", columns: ["任务", "状态"], rows: [["build", "queued"]] },
							{ type: "form", submitLabel: "保存", fields: [{ kind: "input", name: "concurrency", label: "并发上限", value: "2" }] },
						],
					},
				})}
				onAnswer={onAnswer}
			/>,
		);

		expect(screen.getByText("build")).toBeTruthy();
		fireEvent.change(screen.getByLabelText("并发上限"), { target: { value: "8" } });
		fireEvent.click(screen.getByRole("button", { name: "保存" }));
		expect(onAnswer).toHaveBeenCalledWith("d1", { value: JSON.stringify({ values: { concurrency: "8" } }) });
	});

	it("falls back to plain text when the extension was not adapted", () => {
		render(<ExtensionDialogHost dialog={webDialog({ webText: "Tasks 1/3\n────────" })} onAnswer={() => {}} />);
		expect(screen.getByText(/Tasks 1\/3/)).toBeTruthy();
	});

	it("cancel reports cancelled", () => {
		const onAnswer = vi.fn();
		render(<ExtensionDialogHost dialog={webDialog({ tree: { type: "text", text: "hi" } })} onAnswer={onAnswer} />);
		fireEvent.click(screen.getByRole("button", { name: "取消" }));
		expect(onAnswer).toHaveBeenCalledWith("d1", { cancelled: true });
	});
});
