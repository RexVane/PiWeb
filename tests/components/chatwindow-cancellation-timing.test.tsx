// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ChatWindow } from "@/components/ChatWindow";
import type { WebMessage } from "@/lib/types";

afterEach(cleanup);
const user = { role: "user", content: [{ type: "text", text: "test" }], timestamp: 500 } as WebMessage;

describe("stopped tools and model generation time", () => {
	it("shows a stopped command without failure styling or a failure label", () => {
		const call = { role: "assistant", content: [{ type: "toolCall", id: "c", name: "bash", arguments: { command: "sleep 30" } }], stopReason: "toolUse", timestamp: 1000 } as WebMessage;
		const stopped = { role: "assistant", content: [], stopReason: "aborted", timestamp: 2000 } as WebMessage;
		const { container } = render(<ChatWindow messages={[user, call, stopped]} tools={{ c: { name: "bash", args: {}, state: "done", isError: true, result: "started\n\nCommand aborted" } }} />);
		expect(screen.queryByText("失败")).toBeNull();
		expect(container.querySelector('[data-tone="fail"], [data-failed="true"]')).toBeNull();
		expect(screen.getAllByText("已中止").length).toBeGreaterThan(0);
	});

	it("excludes the time spent waiting for an answer from the thinking summary", () => {
		const ask = { role: "assistant", id: "ask", content: [{ type: "thinking", thinking: "Choose a format" }, { type: "toolCall", id: "q", name: "ask_user_question", arguments: { questions: [{ question: "Which format?", options: [{ label: "short" }] }] } }], stopReason: "toolUse", timestamp: 1000, durationMs: 4000 } as WebMessage;
		const answer = { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop", timestamp: 60_000 } as WebMessage;
		render(<ChatWindow messages={[user, ask, answer]} tools={{ q: { name: "ask_user_question", args: {}, state: "done", result: "short", startedAt: 5000, endedAt: 60_000 } }} />);
		expect(screen.getByRole("button", { name: "思考了 4s" })).toBeTruthy();
		expect(screen.queryByRole("button", { name: "思考了 59s" })).toBeNull();
	});
});
