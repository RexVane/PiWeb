// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ChatInput } from "@/components/ChatInput";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function renderInput() {
	const onSend = vi.fn(async () => ({ success: true }));
	render(<ChatInput cwd="/workspace" isStreaming={false} model={{ id: "test", provider: "test", name: "Test" }}
		contextPercent={null} contextTokens={null} contextWindow={null} thinkingLevels={[]} models={[]}
		providerNames={{}} authByProvider={{}} queue={{ steering: [], followUp: [] }}
		onSend={onSend} onSteer={onSend} onAbort={vi.fn()} onSelectModel={vi.fn()} onSelectLevel={vi.fn()} />);
	return { onSend, textarea: screen.getByRole("textbox") as HTMLTextAreaElement };
}

function response(text: string, cursor: number) {
	return { ok: true, json: async () => ({ success: true, data: { prefix: "@he", items: [
		{ label: "hello.ts", value: "@src/hello.ts", description: "src/hello.ts", text, cursor },
		{ label: "hello world.ts", value: '@"src/hello world.ts"', description: "src/hello world.ts", text: '@"src/hello world.ts" ', cursor: 22 },
	] } }) };
}

it("shows results, navigates and completes with Tab, then sends the selected path", async () => {
	const fetchMock = vi.fn(async (_url: string, _options?: RequestInit) => response("@src/hello.ts ", 14));
	vi.stubGlobal("fetch", fetchMock);
	const { textarea, onSend } = renderInput();
	fireEvent.change(textarea, { target: { value: "@he" } });
	await screen.findByRole("listbox");
	expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toEqual({ cwd: "/workspace", text: "@he", cursor: 3 });
	fireEvent.keyDown(textarea, { key: "ArrowDown" });
	fireEvent.keyDown(textarea, { key: "Tab" });
	expect(textarea.value).toBe('@"src/hello world.ts" ');
	expect(onSend).not.toHaveBeenCalled();
	fireEvent.keyDown(textarea, { key: "Escape" });
	fireEvent.keyDown(textarea, { key: "Enter" });
	await waitFor(() => expect(onSend).toHaveBeenCalledWith('@"src/hello world.ts"', []));
});

it("completes at the caret without losing following text and dismisses with Escape", async () => {
	vi.stubGlobal("fetch", vi.fn(async () => response("review @src/hello.ts  later", 21)));
	const { textarea, onSend } = renderInput();
	fireEvent.change(textarea, { target: { value: "review @he later", selectionStart: 10, selectionEnd: 10 } });
	await screen.findByRole("listbox");
	fireEvent.keyDown(textarea, { key: "Enter" });
	expect(textarea.value).toBe("review @src/hello.ts  later");
	expect(onSend).not.toHaveBeenCalled();
	fireEvent.change(textarea, { target: { value: "@he" } });
	await screen.findByRole("listbox");
	fireEvent.keyDown(textarea, { key: "Escape" });
	expect(screen.queryByRole("listbox")).toBeNull();
	expect(textarea.value).toBe("@he");
});

it("discards an old search response after the draft changes", async () => {
	let resolve!: (value: ReturnType<typeof response>) => void;
	vi.stubGlobal("fetch", vi.fn(() => new Promise<ReturnType<typeof response>>((done) => { resolve = done; })));
	const { textarea } = renderInput();
	fireEvent.change(textarea, { target: { value: "@he" } });
	await waitFor(() => expect(resolve).toBeTypeOf("function"));
	fireEvent.change(textarea, { target: { value: "new draft" } });
	await act(async () => resolve(response("@src/hello.ts ", 14)));
	expect(screen.queryByRole("listbox")).toBeNull();
	expect(textarea.value).toBe("new draft");
});
