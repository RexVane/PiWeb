// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState, type ComponentProps } from "react";
import type { ChatDraft, ChatDraftUpdate } from "@/components/ChatInput";
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

function controlledReaders() {
	const readers: Array<{ result: string; onload?: () => void }> = [];
	class Reader {
		result = "data:image/png;base64,cGlj";
		onload?: () => void;
		readAsDataURL() { readers.push(this); }
	}
	vi.stubGlobal("FileReader", Reader); return readers;
}

describe("ChatInput acceptance and attachments", () => {
	it("reserves the image count before reading and prepares only one image at a time", async () => {
		const readers = controlledReaders(); render(<ChatInput {...props()} />);
		fireEvent.paste(screen.getByRole("textbox"), { clipboardData: { files: Array.from({ length: 25 }, (_, index) => new File(["pic"], `${index}.png`, { type: "image/png" })) } });
		await waitFor(() => expect(readers.length).toBe(1));
		expect(screen.getByRole("alert").textContent).toContain("图片");
		for (let index = 0; index < 20; index++) {
			await waitFor(() => expect(readers.length).toBe(index + 1));
			await act(async () => readers[index].onload?.());
		}
		expect(readers).toHaveLength(20); expect(screen.getByTestId("composer-images").querySelectorAll("img")).toHaveLength(20);
	});
	it("appends a late image to its original controlled draft without copying another workspace's text", async () => {
		const readers = controlledReaders();
		function Harness() {
			const [owner, setOwner] = useState<"a" | "b">("a");
			const [drafts, setDrafts] = useState<Record<string, ChatDraft>>({ a: { text: "first", images: [], uploads: [] }, b: { text: "second", images: [], uploads: [] } });
			const update = (change: ChatDraftUpdate) => setDrafts((current) => ({ ...current, [owner]: typeof change === "function" ? change(current[owner]) : change }));
			return <><button onClick={() => setOwner(owner === "a" ? "b" : "a")}>Switch</button><ChatInput {...props({ draft: drafts[owner], onDraftChange: update })} /></>;
		}
		render(<Harness />); fireEvent.paste(screen.getByRole("textbox"), { clipboardData: { files: [new File(["pic"], "a.png", { type: "image/png" })] } });
		await waitFor(() => expect(readers).toHaveLength(1)); fireEvent.click(screen.getByRole("button", { name: "Switch" }));
		await act(async () => readers[0].onload?.());
		expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("second"); expect(screen.queryByTestId("composer-images")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Switch" }));
		expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("first"); expect(screen.getByTestId("composer-images").querySelectorAll("img")).toHaveLength(1);
	});
	it("shows and disables a pending stop until the server finishes", async () => {
		const stopped = deferred<{ success: boolean }>();
		const onAbort = vi.fn(() => stopped.promise);
		render(<ChatInput {...props({ isStreaming: true, onAbort })} />);
		fireEvent.click(screen.getByRole("button", { name: "停止" }));
		const button = screen.getByRole("button", { name: "正在停止…" }) as HTMLButtonElement;
		expect(button.disabled).toBe(true); expect(button.getAttribute("aria-busy")).toBe("true");
		fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" }); expect(onAbort).toHaveBeenCalledOnce();
		await act(async () => stopped.resolve({ success: true }));
		expect((screen.getByRole("button", { name: "停止" }) as HTMLButtonElement).disabled).toBe(false);
	});
	it("explains the GIF size limit without adding a flattened image", async () => {
		render(<ChatInput {...props()} />);
		fireEvent.paste(screen.getByRole("textbox"), { clipboardData: { files: [new File([new Uint8Array(2 * 1024 * 1024 + 1)], "animation.gif", { type: "image/gif" })] } });
		expect(screen.getByRole("alert").textContent).toContain("压缩会丢失动画");
		expect(screen.queryByTestId("composer-images")).toBeNull();
	});
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

	it("uploads several picked files one at a time", async () => {
		let inflight = 0;
		let peak = 0;
		const fetchMock = vi.fn(async (url: string, init: { body: File }) => {
			inflight += 1;
			peak = Math.max(peak, inflight);
			await new Promise((resolve) => setTimeout(resolve, 10));
			inflight -= 1;
			const name = new URL(url, "http://localhost").searchParams.get("name")!;
			return { ok: true, json: async () => ({ success: true, data: { name, path: `/uploads/${name}`, size: init.body.size } }) };
		});
		vi.stubGlobal("fetch", fetchMock);
		render(<ChatInput {...props({})} />);
		const files = ["a.txt", "b.txt", "c.txt"].map((name) => new File(["12345"], name, { type: "text/plain" }));
		fireEvent.paste(screen.getByRole("textbox"), { clipboardData: { files } });
		await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
		await waitFor(() => expect(inflight).toBe(0));
		expect(peak).toBe(1);
	});

	it("dismisses composer errors via close button, new send, or 6s timeout", async () => {
		const onClearUploadError = vi.fn();
		const nextSend = deferred<{ success: boolean; error?: string }>();
		const onSend = vi.fn(() => nextSend.promise);
		render(<ChatInput {...props({ uploadFailure: "上传失败：network", onClearUploadError, onSend })} />);

		expect(screen.getByRole("alert").textContent).toContain("上传失败：network");
		fireEvent.click(screen.getByRole("button", { name: "关闭" }));
		expect(screen.queryByRole("alert")).toBeNull();
		expect(onClearUploadError).toHaveBeenCalledTimes(1);

		const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
		fireEvent.change(textarea, { target: { value: "first" } });
		onSend.mockResolvedValueOnce({ success: false, error: "session is busy accepting another command" });
		fireEvent.keyDown(textarea, { key: "Enter" });
		await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("session is busy accepting another command"));

		onSend.mockImplementationOnce(() => nextSend.promise);
		fireEvent.keyDown(textarea, { key: "Enter" });
		expect(screen.queryByRole("alert")).toBeNull();
		await act(async () => nextSend.resolve({ success: true }));

		vi.useFakeTimers();
		try {
			onSend.mockResolvedValueOnce({ success: false, error: "temporary error" });
			await act(async () => {
				fireEvent.change(textarea, { target: { value: "second" } });
				fireEvent.keyDown(textarea, { key: "Enter" });
				await Promise.resolve();
			});
			expect(screen.getByRole("alert").textContent).toContain("temporary error");
			await act(async () => { vi.advanceTimersByTime(6000); });
			expect(screen.queryByRole("alert")).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});
});
