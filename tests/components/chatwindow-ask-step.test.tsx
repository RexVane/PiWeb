// @vitest-environment jsdom
/** 对话里的「问了你」步骤：等待中显示「等你回答」，答完列出每题答案，跳过 / 超时给一句话 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ChatWindow } from "@/components/ChatWindow";
import { formatOutcome, type AskQuestion } from "@/lib/ask-user";
import type { WebMessage } from "@/lib/types";

afterEach(cleanup);

const questions: AskQuestion[] = [
	{ question: "用哪个数据库？", header: "数据库", options: [{ label: "Postgres" }, { label: "SQLite" }] },
	{ question: "先做哪些功能？", header: "功能", options: [{ label: "登录" }, { label: "搜索" }], multiSelect: true },
];

const call = {
	role: "assistant",
	id: "a1",
	content: [{ type: "toolCall", id: "c1", name: "ask_user_question", arguments: { questions } }],
	stopReason: "toolUse",
	timestamp: 1,
} as unknown as WebMessage;

const done = (result: string) => ({ c1: { name: "ask_user_question", args: { questions }, state: "done" as const, result } });

describe("ask_user_question step", () => {
	it("shows that pi is waiting while the question is open", () => {
		render(<ChatWindow messages={[call]} tools={{ c1: { name: "ask_user_question", args: { questions }, state: "running" } }} isStreaming />);
		expect(screen.getByText("等你回答")).toBeTruthy();
		expect(screen.getByText("用哪个数据库？ · 先做哪些功能？")).toBeTruthy();
	});

	it("lists each answer once answered, the user's own words without the model-facing label", () => {
		const result = formatOutcome(questions, { status: "answered", answers: [{ selected: ["SQLite"] }, { selected: ["登录"], other: "导入 CSV" }] });
		render(<ChatWindow messages={[call]} tools={done(result)} />);
		expect(screen.getByText("问了你")).toBeTruthy();
		expect(screen.getByText("1. 用哪个数据库？ → SQLite")).toBeTruthy();
		expect(screen.getByText("2. 先做哪些功能？ → 登录; 导入 CSV")).toBeTruthy();
	});

	it("says so when the user skipped or did not answer in time", () => {
		const { unmount } = render(<ChatWindow messages={[call]} tools={done(formatOutcome(questions, { status: "skipped" }))} />);
		expect(screen.getByText("你跳过了这些问题")).toBeTruthy();
		unmount();
		render(<ChatWindow messages={[call]} tools={done(formatOutcome(questions, { status: "timeout" }))} />);
		expect(screen.getByText("30 分钟没回答，pi 已按未回答继续")).toBeTruthy();
	});
});
