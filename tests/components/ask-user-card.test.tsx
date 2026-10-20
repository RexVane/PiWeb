// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AskUserCard } from "@/components/AskUserCard";
import type { ExtensionDialog } from "@/hooks/usePiWeb";
import type { AskQuestion } from "@/lib/ask-user";

afterEach(cleanup);

const DB: AskQuestion = { question: "用哪个数据库？", header: "数据库", options: [{ label: "Postgres（推荐）", description: "稳" }, { label: "SQLite", description: "单文件" }] };
const FEATURES: AskQuestion = { question: "先做哪些功能？", header: "功能", options: [{ label: "登录" }, { label: "搜索" }, { label: "导出" }], multiSelect: true };

function dialog(questions: AskQuestion[]): ExtensionDialog {
	return { id: "ask-1", method: "questions", title: "", questions, ts: 1 };
}

const sent = (onAnswer: ReturnType<typeof vi.fn>) => JSON.parse(onAnswer.mock.calls[0][1].value);

describe("AskUserCard", () => {
	it("submits the picked option only once every question has an answer", () => {
		const onAnswer = vi.fn();
		render(<AskUserCard dialog={dialog([DB])} onAnswer={onAnswer} />);
		expect(screen.getByText("pi 想问你")).toBeTruthy();
		expect(screen.getByText("稳")).toBeTruthy();
		const submit = screen.getByRole("button", { name: "提交" }) as HTMLButtonElement;
		expect(submit.disabled).toBe(true);
		fireEvent.click(screen.getByRole("radio", { name: /SQLite/ }));
		expect(screen.getByRole("radio", { name: /SQLite/ }).getAttribute("aria-checked")).toBe("true");
		expect(submit.disabled).toBe(false);
		fireEvent.click(submit);
		expect(onAnswer).toHaveBeenCalledWith("ask-1", { value: expect.any(String) });
		expect(sent(onAnswer)).toEqual({ answers: [{ selected: ["SQLite"] }] });
	});

	it("moves to the next question after a single choice and collects multi-select plus own words", () => {
		const onAnswer = vi.fn();
		render(<AskUserCard dialog={dialog([DB, FEATURES])} onAnswer={onAnswer} />);
		expect(screen.getByText("pi 想问你 2 个问题")).toBeTruthy();
		expect(screen.getByRole("button", { name: "下一题" })).toBeTruthy();
		fireEvent.click(screen.getByRole("radio", { name: /Postgres/ }));
		// 单选点了自动跳到第二题（多选）
		expect(screen.getByText("先做哪些功能？")).toBeTruthy();
		expect(screen.getByText("可多选")).toBeTruthy();
		fireEvent.click(screen.getByRole("checkbox", { name: /登录/ }));
		fireEvent.click(screen.getByRole("checkbox", { name: /导出/ }));
		fireEvent.change(screen.getByLabelText("其他"), { target: { value: "  导入 CSV " } });
		fireEvent.click(screen.getByRole("button", { name: "提交" }));
		expect(sent(onAnswer)).toEqual({ answers: [{ selected: ["Postgres（推荐）"] }, { selected: ["登录", "导出"], other: "导入 CSV" }] });
	});

	it("keeps every pick when several clicks and typing land before a re-render", () => {
		// 回归：处理函数读渲染闭包里的旧 draft，连点两项再打字，只剩最后一次改动
		const onAnswer = vi.fn();
		render(<AskUserCard dialog={dialog([FEATURES])} onAnswer={onAnswer} />);
		act(() => {
			(screen.getByRole("checkbox", { name: /登录/ }) as HTMLButtonElement).click();
			(screen.getByRole("checkbox", { name: /导出/ }) as HTMLButtonElement).click();
			fireEvent.change(screen.getByLabelText("其他"), { target: { value: "导入 CSV" } });
		});
		fireEvent.click(screen.getByRole("button", { name: "提交" }));
		expect(sent(onAnswer)).toEqual({ answers: [{ selected: ["登录", "导出"], other: "导入 CSV" }] });
	});

	it("lets the user's own words replace a single choice, and skip answers as cancelled", () => {
		const onAnswer = vi.fn();
		render(<AskUserCard dialog={dialog([DB])} onAnswer={onAnswer} />);
		fireEvent.click(screen.getByRole("radio", { name: /SQLite/ }));
		fireEvent.change(screen.getByLabelText("其他"), { target: { value: "MySQL" } });
		expect(screen.getByRole("radio", { name: /SQLite/ }).getAttribute("aria-checked")).toBe("false");
		fireEvent.click(screen.getByRole("button", { name: "提交" }));
		expect(sent(onAnswer)).toEqual({ answers: [{ selected: [], other: "MySQL" }] });
		fireEvent.click(screen.getByRole("button", { name: "跳过" }));
		expect(onAnswer).toHaveBeenLastCalledWith("ask-1", { cancelled: true });
	});

	it("picks with number keys and submits with Enter while the card has focus", () => {
		const onAnswer = vi.fn();
		render(<AskUserCard dialog={dialog([DB])} onAnswer={onAnswer} />);
		const card = screen.getByTestId("ask-user-card");
		// 弹出时焦点在页面本身：自动挪进卡片，数字键直接可用
		expect(document.activeElement).toBe(card);
		fireEvent.keyDown(card, { key: "2" });
		expect(screen.getByRole("radio", { name: /SQLite/ }).getAttribute("aria-checked")).toBe("true");
		fireEvent.keyDown(card, { key: "Enter" });
		expect(sent(onAnswer)).toEqual({ answers: [{ selected: ["SQLite"] }] });
	});

	it("does not steal focus from the composer when the question arrives mid-typing", () => {
		const input = document.createElement("textarea");
		document.body.appendChild(input);
		input.focus();
		render(<AskUserCard dialog={dialog([DB])} onAnswer={vi.fn()} />);
		expect(document.activeElement).toBe(input);
		input.remove();
	});
});
