// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ChatInput, type SlashCommand } from "@/components/ChatInput";

afterEach(cleanup);

const commands: SlashCommand[] = [
	{ name: "compact", desc: "压缩更早的对话历史", kind: "builtin" },
	{ name: "goal-list", desc: "列出当前目标", kind: "extension" },
	{ name: "skill:probe", desc: "Probe skill", kind: "skill" },
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
	return { onSend, onCommand, textarea: screen.getByRole("textbox") as HTMLTextAreaElement };
}

describe("ChatInput slash commands", () => {
	it("keeps multiline prose full-width and exposes an explicit skill removal button", () => {
		const { textarea, onSend } = renderInput();
		fireEvent.change(textarea, { target: { value: "first line\nsecond line /skill" } });
		fireEvent.keyDown(textarea, { key: "Tab" });
		expect(textarea.value).toBe("first line\nsecond line ");
		expect(textarea.parentElement?.classList.contains("flex-col")).toBe(true);
		expect(textarea.classList.contains("w-full")).toBe(true);
		fireEvent.click(screen.getByRole("button", { name: "删除 /skill:probe" }));
		expect(screen.queryByRole("button", { name: "删除 /skill:probe" })).toBeNull();
		expect(textarea.value).toBe("first line\nsecond line ");
		expect(onSend).not.toHaveBeenCalled();
	});

	it("removes a skill with Backspace at the start even when its arguments are nonempty", () => {
		const { textarea } = renderInput();
		fireEvent.change(textarea, { target: { value: "keep this /skill" } });
		fireEvent.keyDown(textarea, { key: "Tab" });
		textarea.setSelectionRange(0, 0);
		fireEvent.keyDown(textarea, { key: "Backspace" });
		expect(screen.queryByRole("button", { name: "删除 /skill:probe" })).toBeNull();
		expect(textarea.value).toBe("keep this ");
	});

	it("does not offer another command or replace the first skill after spaces or newlines", () => {
		const { textarea, onSend } = renderInput();
		fireEvent.change(textarea, { target: { value: "/skill" } });
		fireEvent.keyDown(textarea, { key: "Tab" });
		for (const text of ["arguments /", "arguments\n/skill", "arguments\n/goal"]) {
			fireEvent.change(textarea, { target: { value: text } });
			expect(screen.queryByRole("listbox")).toBeNull();
			expect(screen.getByRole("button", { name: "删除 /skill:probe" })).toBeTruthy();
		}
		expect(onSend).not.toHaveBeenCalled();
	});

	it("enables sending a skill without arguments and ignores IME Backspace", () => {
		const { textarea } = renderInput();
		fireEvent.change(textarea, { target: { value: "/skill" } });
		fireEvent.keyDown(textarea, { key: "Tab" });
		expect((screen.getByTitle("发送") as HTMLButtonElement).disabled).toBe(false);
		fireEvent.keyDown(textarea, { key: "Backspace", isComposing: true });
		expect(screen.getByRole("button", { name: "删除 /skill:probe" })).toBeTruthy();
	});

	it.each(["existing draft /", "existing draft\n/", " /"])("opens completion after whitespace in %j", (text) => {
		const { textarea } = renderInput();
		fireEvent.change(textarea, { target: { value: text } });
		expect(screen.getByRole("listbox").textContent).toContain("goal-list");
	});

	it("executes an inline builtin without clearing the surrounding draft", async () => {
		const { textarea, onCommand, onSend } = renderInput();
		fireEvent.change(textarea, { target: { value: "keep this /com" } });
		fireEvent.keyDown(textarea, { key: "Enter" });
		expect(onCommand).toHaveBeenCalledWith("compact", "");
		expect(textarea.value).toBe("keep this ");
		expect(onSend).not.toHaveBeenCalled();
	});

	it("executes an inline extension separately and keeps the draft", async () => {
		const { textarea, onSend } = renderInput();
		fireEvent.change(textarea, { target: { value: "keep this /goal" } });
		fireEvent.keyDown(textarea, { key: "Enter" });
		await waitFor(() => expect(onSend).toHaveBeenCalledWith("/goal-list", []));
		expect(textarea.value).toBe("keep this ");
	});

	it("keeps the complete draft and command available if inline execution fails", async () => {
		const { textarea, onSend } = renderInput();
		onSend.mockRejectedValueOnce(new Error("Command failed"));
		fireEvent.change(textarea, { target: { value: "keep this /goal" } });
		fireEvent.keyDown(textarea, { key: "Enter" });
		await waitFor(() => expect(textarea.value).toBe("keep this /goal"));
		expect(screen.getByRole("alert").textContent).toContain("Command failed");
	});

	it("adopts an inline skill without sending or losing existing prose", async () => {
		const { textarea, onSend } = renderInput();
		fireEvent.change(textarea, { target: { value: "explain this /skill" } });
		fireEvent.keyDown(textarea, { key: "Enter" });
		expect(textarea.value).toBe("explain this ");
		expect(screen.getByRole("button", { name: /skill:probe/ })).toBeTruthy();
		expect(onSend).not.toHaveBeenCalled();
		fireEvent.keyDown(textarea, { key: "Enter" });
		await waitFor(() => expect(onSend).toHaveBeenCalledWith("/skill:probe explain this", []));
	});

	it("uses the caret and preserves the rest of the token and following prose on Tab", () => {
		const { textarea, onSend } = renderInput();
		fireEvent.change(textarea, { target: { value: "before /goal-list after" } });
		expect(screen.queryByRole("listbox")).toBeNull();
		textarea.setSelectionRange(12, 12);
		fireEvent.select(textarea);
		expect(screen.getByRole("listbox").textContent).toContain("goal-list");
		fireEvent.keyDown(textarea, { key: "Tab" });
		expect(textarea.value).toBe("before  after");
		expect(onSend).not.toHaveBeenCalled();
	});

	it("does not intercept selection or IME key presses, and ignores paths and URLs", () => {
		const { textarea, onSend, onCommand } = renderInput();
		for (const text of ["https://example.com/goal", "src/goal", "/src/goal"]) {
			fireEvent.change(textarea, { target: { value: text } });
			expect(screen.queryByRole("listbox")).toBeNull();
		}
		fireEvent.change(textarea, { target: { value: "text /goal" } });
		fireEvent.keyDown(textarea, { key: "Enter", isComposing: true });
		expect(onSend).not.toHaveBeenCalled();
		expect(onCommand).not.toHaveBeenCalled();
		textarea.setSelectionRange(0, textarea.value.length);
		fireEvent.select(textarea);
		expect(screen.queryByRole("listbox")).toBeNull();
	});

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
