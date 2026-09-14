// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ChatInput, type SlashCommand } from "@/components/ChatInput";

afterEach(cleanup);

const commands: SlashCommand[] = [
	{ name: "compact", desc: "压缩更早的对话历史", kind: "builtin" },
	{ name: "goal-list", desc: "列出当前目标", kind: "extension" },
];

function renderInput() {
	const onSend = vi.fn(async () => ({ success: true }));
	const onCommand = vi.fn();
	render(
		<ChatInput
			isStreaming={false}
			model={{ provider: "test", id: "test-model", name: "Test Model" }}
			contextPercent={null}
			contextTokens={null}
			contextWindow={null}
			thinkingLevels={[]}
			models={[]}
			providerNames={{}}
			authByProvider={{}}
			queue={{ steering: [], followUp: [] }}
			commands={commands}
			onCommand={onCommand}
			onSend={onSend}
			onSteer={vi.fn(async () => ({ success: true }))}
			onAbort={vi.fn()}
			onSelectModel={vi.fn()}
			onSelectLevel={vi.fn()}
		/>,
	);
	return { onSend, onCommand, textarea: screen.getByRole("textbox") };
}

describe("ChatInput slash commands", () => {
	it("opens the command menu when typing a slash and filters as you type", () => {
		const { textarea } = renderInput();
		fireEvent.change(textarea, { target: { value: "/" } });
		const list = screen.getByRole("listbox");
		expect(list.textContent).toContain("compact");
		expect(list.textContent).toContain("goal-list");

		fireEvent.change(textarea, { target: { value: "/goal" } });
		expect(screen.getByRole("listbox").textContent).toContain("goal-list");
		expect(screen.getByRole("listbox").textContent).not.toContain("compact");
	});

	it("adopts the highlighted command with Tab as an inline marker instead of sending", async () => {
		const { textarea, onSend } = renderInput();
		fireEvent.change(textarea, { target: { value: "/goal" } });
		fireEvent.keyDown(textarea, { key: "Tab" });

		await waitFor(() => expect(screen.getByRole("button", { name: /goal-list/ })).toBeTruthy());
		expect((textarea as HTMLTextAreaElement).value).toBe("");
		expect(screen.queryByRole("listbox")).toBeNull();
		expect(onSend).not.toHaveBeenCalled();
	});

	it("sends the adopted command with typed arguments", async () => {
		const { textarea, onSend } = renderInput();
		fireEvent.change(textarea, { target: { value: "/goal" } });
		fireEvent.keyDown(textarea, { key: "Tab" });
		await waitFor(() => expect(screen.getByRole("button", { name: /goal-list/ })).toBeTruthy());

		fireEvent.change(textarea, { target: { value: "active only" } });
		fireEvent.keyDown(textarea, { key: "Enter" });
		await waitFor(() => expect(onSend).toHaveBeenCalledWith("/goal-list active only", []));
		await waitFor(() => expect(screen.queryByRole("button", { name: /goal-list/ })).toBeNull());
	});

	it("removes the adopted marker with Backspace on an empty input", async () => {
		const { textarea } = renderInput();
		fireEvent.change(textarea, { target: { value: "/goal" } });
		fireEvent.keyDown(textarea, { key: "Tab" });
		await waitFor(() => expect(screen.getByRole("button", { name: /goal-list/ })).toBeTruthy());

		fireEvent.keyDown(textarea, { key: "Backspace" });
		await waitFor(() => expect(screen.queryByRole("button", { name: /goal-list/ })).toBeNull());
	});

	it("runs builtin commands through onCommand instead of onSend", async () => {
		const { textarea, onSend, onCommand } = renderInput();
		fireEvent.change(textarea, { target: { value: "/compact" } });
		fireEvent.keyDown(textarea, { key: "Enter" });
		await waitFor(() => expect(onCommand).toHaveBeenCalledWith("compact", ""));
		expect(onSend).not.toHaveBeenCalled();
	});
});
