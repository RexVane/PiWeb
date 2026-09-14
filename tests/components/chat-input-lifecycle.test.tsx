// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { ChatInput } from "@/components/ChatInput";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}
function props(overrides: Partial<ComponentProps<typeof ChatInput>> = {}): ComponentProps<typeof ChatInput> {
	return {
		isStreaming: false, contextPercent: null, contextTokens: null, contextWindow: null,
		model: { id: "test-model", provider: "test", name: "Test" }, thinkingLevels: [], models: [],
		providerNames: {}, authByProvider: {}, queue: { steering: [], followUp: [] },
		onSend: vi.fn(async () => ({ success: true })), onSteer: vi.fn(async () => ({ success: true })),
		onFollowUp: vi.fn(async () => ({ success: true })), onAbort: vi.fn(), onSelectModel: vi.fn(), onSelectLevel: vi.fn(),
		...overrides,
	};
}

describe("ChatInput acceptance and attachments", () => {
	it("prevents duplicate pending acceptance, then permits steer/follow-up during streaming", async () => {
		const accepted = deferred<{ success: boolean }>();
		const onSend = vi.fn(() => accepted.promise);
		const onSteer = vi.fn(async () => ({ success: true }));
		const onFollowUp = vi.fn(async () => ({ success: true }));
		const inputProps = props({ onSend, onSteer, onFollowUp });
		const { rerender } = render(<ChatInput {...inputProps} />);
		const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
		fireEvent.change(textarea, { target: { value: "first" } });
		fireEvent.keyDown(textarea, { key: "Enter" });
		fireEvent.keyDown(textarea, { key: "Enter" });
		expect(onSend).toHaveBeenCalledTimes(1);
		expect(textarea.disabled).toBe(true);
		expect(textarea.value).toBe("first");
		rerender(<ChatInput {...inputProps} isStreaming />);
		expect(textarea.disabled).toBe(true);
		await act(async () => accepted.resolve({ success: true }));
		expect(textarea.value).toBe("");
		expect(textarea.disabled).toBe(false);
		fireEvent.change(textarea, { target: { value: "steer now" } });
		fireEvent.keyDown(textarea, { key: "Enter" });
		await waitFor(() => expect(onSteer).toHaveBeenCalledWith("steer now", []));
		await waitFor(() => expect(textarea.disabled).toBe(false));
		fireEvent.change(textarea, { target: { value: "next round" } });
		fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });
		await waitFor(() => expect(onFollowUp).toHaveBeenCalledWith("next round", []));
		expect(onSend).toHaveBeenCalledTimes(1);
	});

	it.each(["failure", "rejection"])("retains text and file drafts on acceptance %s", async (kind) => {
		const accepted = deferred<{ success: boolean; error?: string }>();
		render(<ChatInput {...props({ onSend: () => accepted.promise, initialDraft: { text: "keep me", images: [], uploads: [{ name: "note.txt", path: "/uploads/note.txt", size: 4 }] } })} />);
		fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
		await act(async () => {
			if (kind === "failure") accepted.resolve({ success: false, error: "preflight rejected" });
			else accepted.reject(new Error("network down"));
		});
		expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("keep me");
		expect(screen.getByText("note.txt")).toBeTruthy();
		expect(screen.getByRole("alert").textContent).toContain(kind === "failure" ? "preflight rejected" : "network down");
		expect((screen.getByRole("textbox") as HTMLTextAreaElement).disabled).toBe(false);
	});

	it("declares upload size and rejects truncated successes without attaching a file", async () => {
		const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ success: true, data: { name: "large.txt", path: "/uploads/large.txt", size: 2 } }) }));
		vi.stubGlobal("fetch", fetchMock);
		const onUploadError = vi.fn();
		const onUploadProgress = vi.fn();
		render(<ChatInput {...props({ onUploadError, onUploadProgress })} />);
		const file = new File(["12345"], "large.txt", { type: "text/plain" });
		fireEvent.paste(screen.getByRole("textbox"), { clipboardData: { files: [file] } });
		await waitFor(() => expect(onUploadError).toHaveBeenCalled());
		expect(fetchMock).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ headers: { "Content-Type": "application/octet-stream", "x-upload-size": "5" }, body: file }));
		expect(screen.getByRole("alert").textContent).toContain("upload size mismatch");
		expect(screen.queryByText("large.txt")).toBeNull();
		expect(onUploadProgress.mock.calls.map(([delta]) => delta)).toEqual([1, -1]);
	});
});
