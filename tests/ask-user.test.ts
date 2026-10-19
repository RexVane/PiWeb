import { afterEach, describe, expect, it, vi } from "vitest";
import { ASK_RESULT_PREFIX, ASK_USER_TIMEOUT_MS, formatOutcome, normalizeQuestions, parseAnswers, type AskQuestion } from "../src/lib/ask-user";
import { createAskUserTool } from "../src/lib/ask-user-tool";
import { createExtensionUiBridge } from "../src/lib/extension-ui";
import type { WebEvent } from "../src/lib/types";

afterEach(() => vi.useRealTimers());

const DB: AskQuestion = { question: "Which DB?", header: "DB", options: [{ label: "Postgres (Recommended)", description: "solid" }, { label: "SQLite" }] };
const FEATURES: AskQuestion = { question: "Which features?", header: "Features", options: [{ label: "Auth" }, { label: "Search" }, { label: "Export" }], multiSelect: true };

describe("ask_user_question helpers", () => {
	it("normalizes model arguments: trims, drops empty options and questions, caps counts, fills the header", () => {
		const questions = normalizeQuestions({
			questions: [
				{ question: "  Which DB?  ", header: " ", options: [{ label: " Postgres ", description: " " }, { label: "" }, { label: "SQLite", description: "file" }] },
				{ question: "No options?", header: "x", options: [{ label: "  " }] },
				{ question: "", header: "empty", options: [{ label: "a" }, { label: "b" }] },
				{ question: "Q3", header: "3", options: [1, 2, 3, 4, 5].map((n) => ({ label: `o${n}` })), multiSelect: true },
				{ question: "Q4", header: "4", options: [{ label: "a" }, { label: "b" }] },
				{ question: "Q5", header: "5", options: [{ label: "a" }, { label: "b" }] },
			],
		});
		expect(questions).toEqual([
			{ question: "Which DB?", header: "Which DB?", options: [{ label: "Postgres" }, { label: "SQLite", description: "file" }] },
			{ question: "Q3", header: "3", options: [{ label: "o1" }, { label: "o2" }, { label: "o3" }, { label: "o4" }], multiSelect: true },
		]);
		expect(normalizeQuestions(null)).toEqual([]);
		expect(normalizeQuestions({ questions: "nope" })).toEqual([]);
	});

	it("accepts only real option labels, one per single-select question, and lets the user's own words win there", () => {
		const value = JSON.stringify({ answers: [{ selected: ["SQLite", "Postgres (Recommended)", "Made up"] }, { selected: ["Auth", "Export", "Auth", 7], other: "  CSV import  " }] });
		expect(parseAnswers([DB, FEATURES], value)).toEqual([{ selected: ["SQLite"] }, { selected: ["Auth", "Export"], other: "CSV import" }]);
		expect(parseAnswers([DB], JSON.stringify({ answers: [{ selected: ["SQLite"], other: "MySQL" }] }))).toEqual([{ selected: [], other: "MySQL" }]);
		expect(parseAnswers([DB], JSON.stringify({ answers: [{ other: "x".repeat(5000) }] }))![0].other).toHaveLength(4000);
		expect(parseAnswers([DB], "not json")).toBeNull();
		expect(parseAnswers([DB], JSON.stringify({ answers: "SQLite" }))).toBeNull();
		expect(parseAnswers([DB], undefined)).toBeNull();
	});

	it("formats the result for the model with a fixed first line per outcome", () => {
		const answered = formatOutcome([DB, FEATURES], { status: "answered", answers: [{ selected: ["SQLite"] }, { selected: ["Auth"], other: "CSV import" }] });
		expect(answered.split("\n")).toEqual([
			ASK_RESULT_PREFIX.answered,
			"1. Which DB? → SQLite",
			"2. Which features? → Auth; (their own words) CSV import",
			"Continue with these answers in mind.",
		]);
		expect(formatOutcome([DB], { status: "skipped" }).startsWith(ASK_RESULT_PREFIX.skipped)).toBe(true);
		expect(formatOutcome([DB], { status: "timeout" }).startsWith(ASK_RESULT_PREFIX.timeout)).toBe(true);
		expect(formatOutcome([DB], { status: "unavailable" })).toMatch(/plain text/);
	});
});

describe("ask_user_question tool", () => {
	it("asks with normalized questions and returns the formatted outcome plus details", async () => {
		const ask = vi.fn(async () => ({ status: "answered" as const, answers: [{ selected: ["SQLite"] }] }));
		const tool = createAskUserTool(ask);
		expect(tool.name).toBe("ask_user_question");
		const result = await tool.execute("call-1", { questions: [{ ...DB, question: " Which DB? " }] }, undefined, undefined, undefined as never);
		expect(ask).toHaveBeenCalledWith([DB], undefined);
		expect(result.content).toEqual([{ type: "text", text: expect.stringContaining("1. Which DB? → SQLite") }]);
		expect(result.details).toEqual({ questions: [DB], outcome: { status: "answered", answers: [{ selected: ["SQLite"] }] } });
	});

	it("does not open a window for arguments without a usable question", async () => {
		const ask = vi.fn();
		const result = await createAskUserTool(ask).execute("call-2", { questions: [{ question: "Huh?", header: "x", options: [] }] } as never, undefined, undefined, undefined as never);
		expect(ask).not.toHaveBeenCalled();
		expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringMatching(/No valid questions/) });
	});
});

describe("question window on the extension UI bridge", () => {
	it("waits even with no page open, exposes the questions in pending requests and parses the answer", async () => {
		const events: WebEvent[] = [];
		const bridge = createExtensionUiBridge({ publish: (evt) => events.push(evt), hasViewers: () => false });
		const answer = bridge.askQuestions([DB, FEATURES]);
		const [request] = bridge.getPendingRequests();
		expect(request).toMatchObject({ type: "extension_ui", method: "questions", questions: [DB, FEATURES], timeout: ASK_USER_TIMEOUT_MS });
		// 快照里的题目是拷贝：浏览器端改不到服务端的原件
		request.questions![0].options.push({ label: "Mutated" });
		expect(bridge.getPendingRequests()[0].questions![0].options).toHaveLength(2);
		expect(events[0]).toMatchObject({ type: "extension_ui", method: "questions" });
		expect(bridge.respond(request.id, { value: JSON.stringify({ answers: [{ selected: ["SQLite"] }, { selected: ["Search"] }] }) })).toBe(true);
		expect(await answer).toEqual({ status: "answered", answers: [{ selected: ["SQLite"] }, { selected: ["Search"] }] });
		expect(bridge.getPendingRequests()).toEqual([]);
		expect(events.at(-1)).toMatchObject({ type: "extension_ui_resolved", id: request.id });
		bridge.dispose();
	});

	it("reports skip, garbled answers, dispose and stop as skipped", async () => {
		const bridge = createExtensionUiBridge({ publish: () => {}, hasViewers: () => true });
		const skip = bridge.askQuestions([DB]);
		bridge.respond(bridge.getPendingRequests()[0].id, { cancelled: true });
		expect(await skip).toEqual({ status: "skipped" });
		const garbled = bridge.askQuestions([DB]);
		bridge.respond(bridge.getPendingRequests()[0].id, { value: "{" });
		expect(await garbled).toEqual({ status: "skipped" });
		const controller = new AbortController();
		const stopped = bridge.askQuestions([DB], controller.signal);
		controller.abort();
		expect(await stopped).toEqual({ status: "skipped" });
		const disposed = bridge.askQuestions([DB]);
		bridge.dispose();
		expect(await disposed).toEqual({ status: "skipped" });
		expect(await bridge.askQuestions([DB])).toEqual({ status: "unavailable" });
	});

	it("gives up after 30 minutes and says so", async () => {
		vi.useFakeTimers();
		const bridge = createExtensionUiBridge({ publish: () => {}, hasViewers: () => false });
		const answer = bridge.askQuestions([DB]);
		await vi.advanceTimersByTimeAsync(ASK_USER_TIMEOUT_MS - 1);
		expect(bridge.getPendingRequests()).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(await answer).toEqual({ status: "timeout" });
		expect(bridge.getPendingRequests()).toEqual([]);
		bridge.dispose();
	});
});
