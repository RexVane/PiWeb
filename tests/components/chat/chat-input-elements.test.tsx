// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { ChatInput, type ChatDraft } from "@/components/chat/ChatInput";
import type { DraftElement } from "@/lib/browser/element-draft";

afterEach(() => { cleanup(); localStorage.clear(); });

const picked: DraftElement = {
	key: "el-1",
	label: "<button#save> “保存”",
	selector: "main > button#save",
	pageUrl: "http://localhost:5173/",
	component: "Settings",
	locations: [{ path: "src/Settings.tsx", line: 42 }],
	crop: { type: "image", data: "CROP", mimeType: "image/jpeg" },
};

function props(overrides: Partial<ComponentProps<typeof ChatInput>> = {}): ComponentProps<typeof ChatInput> {
	return {
		isStreaming: false, contextPercent: null, contextTokens: null, contextWindow: null,
		model: { id: "m", provider: "p", name: "M" }, thinkingLevels: [],
		models: [{ provider: "p", id: "m", name: "M", reasoning: false, contextWindow: 128000, vision: false }],
		providerNames: {}, authByProvider: { p: true }, queue: { steering: [], followUp: [] },
		onSend: vi.fn(async () => ({ success: true })), onSteer: vi.fn(async () => ({ success: true })),
		onFollowUp: vi.fn(async () => ({ success: true })), onAbort: vi.fn(), onSelectModel: vi.fn(), onSelectLevel: vi.fn(),
		...overrides,
	};
}

describe("element chips in the composer", () => {
	it("shows the element with its first source location and removes it", () => {
		const drafts: ChatDraft[] = [];
		render(<ChatInput {...props({ initialDraft: { text: "", images: [], uploads: [], elements: [picked] }, onDraftChange: (update) => { if (typeof update !== "function") drafts.push(update); } })} />);
		const chips = screen.getByTestId("element-chips");
		expect(within(chips).getByText("<button#save> “保存”")).toBeTruthy();
		expect(within(chips).getByText("src/Settings.tsx:42")).toBeTruthy();
		fireEvent.click(within(chips).getByRole("button", { name: "remove" }));
		expect(screen.queryByTestId("element-chips")).toBeNull();
	});

	it("sends the element description as text only when the model cannot see images", async () => {
		const onSend = vi.fn(async () => ({ success: true }));
		render(<ChatInput {...props({ onSend, initialDraft: { text: "把它改成红色", images: [], uploads: [], elements: [picked] } })} />);
		fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
		await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
		const [text, images] = onSend.mock.calls[0] as unknown as [string, unknown[]];
		expect(text.startsWith("把它改成红色\n\n")).toBe(true);
		expect(text).toMatch(/<button#save> “保存”/);
		expect(text).toMatch(/src\/Settings\.tsx:42/);
		expect(text).not.toMatch(/张附图|attached image/);
		expect(images).toEqual([]);
		await waitFor(() => expect(screen.queryByTestId("element-chips")).toBeNull());
	});

	it("attaches the element crop after the user's images for vision models, and can send elements alone", async () => {
		const onSend = vi.fn(async () => ({ success: true }));
		const own = { type: "image" as const, data: "OWN", mimeType: "image/png" };
		render(<ChatInput {...props({
			onSend,
			models: [{ provider: "p", id: "m", name: "M", reasoning: false, contextWindow: 128000, vision: true }],
			initialDraft: { text: "", images: [own], uploads: [], elements: [picked] },
		})} />);
		fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
		await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
		const [text, images] = onSend.mock.calls[0] as unknown as [string, Array<{ data: string }>];
		expect(images.map((image) => image.data)).toEqual(["OWN", "CROP"]);
		expect(text).toMatch(/第 2 张附图|attached image 2/);
	});
});
