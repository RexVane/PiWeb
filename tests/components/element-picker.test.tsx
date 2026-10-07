// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ChatWindow } from "@/components/ChatWindow";
import { ElementPickContext, type ElementPickApi } from "@/components/ElementPicker";
import type { WebMessage } from "@/lib/types";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function conversation(toolName: string) {
	const messages: WebMessage[] = [
		{ id: "u1", role: "user", content: [{ type: "text", text: "看看页面" }], timestamp: 1 },
		{ id: "a1", role: "assistant", content: [{ type: "toolCall", id: "call-1", name: toolName, arguments: { url: "http://localhost:5173" } }], stopReason: "toolUse", timestamp: 2 },
		{ id: "a2", role: "assistant", content: [{ type: "text", text: "页面正常" }], stopReason: "stop", timestamp: 3 },
	];
	const tools = { "call-1": { name: toolName, args: { url: "http://localhost:5173" }, state: "done" as const, result: "Page: App", images: [{ data: "OLD", mimeType: "image/jpeg" }] } };
	return { messages, tools };
}

const capture = { image: { data: "FRESH", mimeType: "image/jpeg" }, width: 1280, height: 800, device: "desktop", url: "http://localhost:5173/", title: "App" };
const pickResult = {
	element: {
		tag: "button", id: "save", text: "保存", domPath: "main > button#save", attrs: {}, label: "<button#save> “保存”",
		hints: [{ framework: "react", file: "/w/src/Settings.tsx", line: 42, component: "Settings" }],
		box: { x: 320, y: 200, width: 100, height: 40 }, scroll: { x: 0, y: 0 }, pageUrl: "http://localhost:5173/", title: "App",
	},
	locations: [{ path: "src/Settings.tsx", line: 42, lineText: "<button>保存</button>", kind: "source-attr" }],
	crop: { data: "CROP", mimeType: "image/jpeg" },
};

function json(data: unknown, status = 200) {
	return Promise.resolve(new Response(JSON.stringify(status < 400 ? { success: true, data } : { success: false, error: data }), { status, headers: { "Content-Type": "application/json" } }));
}

describe("picking elements on pi's screenshots", () => {
	it("is only offered for browser tool screenshots inside a session view", () => {
		const browser = conversation("browser_open");
		const { unmount } = render(<ChatWindow messages={browser.messages} tools={browser.tools} />);
		expect(screen.queryByText(/选元素|Pick element/)).toBeNull();
		unmount();
		const api: ElementPickApi = { sessionId: "c2Vzc2lvbi1pZA", onPick: vi.fn() };
		const other = conversation("read");
		render(<ElementPickContext.Provider value={api}><ChatWindow messages={other.messages} tools={other.tools} /></ElementPickContext.Provider>);
		expect(screen.queryByText(/选元素|Pick element/)).toBeNull();
	});

	it("captures a fresh screenshot, maps the click to page coordinates and adds an element chip", async () => {
		const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body));
			return body.action === "capture" ? json(capture) : json(pickResult);
		});
		vi.stubGlobal("fetch", fetchMock);
		const onPick = vi.fn();
		const { messages, tools } = conversation("browser_open");
		render(<ElementPickContext.Provider value={{ sessionId: "c2Vzc2lvbi1pZA", onPick }}><ChatWindow messages={messages} tools={tools} /></ElementPickContext.Provider>);

		fireEvent.click(screen.getByRole("button", { name: /选元素|Pick element/ }));
		const dialog = await screen.findByRole("dialog");
		const fresh = await waitFor(() => {
			const img = dialog.querySelector("img[src='data:image/jpeg;base64,FRESH']") as HTMLImageElement | null;
			if (!img) throw new Error("fresh capture not shown yet");
			return img;
		});
		expect(fetchMock.mock.calls[0][0]).toBe("/api/browser");
		expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ action: "capture", session: "c2Vzc2lvbi1pZA" });

		// 截图按一半大小显示：点在显示区域 (160, 110) → 页面视口 (320, 220)
		vi.spyOn(fresh, "getBoundingClientRect").mockReturnValue({ left: 100, top: 50, width: 640, height: 400, right: 740, bottom: 450, x: 100, y: 50, toJSON: () => ({}) } as DOMRect);
		fireEvent.click(fresh, { clientX: 260, clientY: 160 });
		await waitFor(() => expect(onPick).toHaveBeenCalledTimes(1));
		expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({ action: "pick", session: "c2Vzc2lvbi1pZA", x: 320, y: 220 });
		expect(onPick.mock.calls[0][0]).toMatchObject({
			label: "<button#save> “保存”",
			selector: "main > button#save",
			pageUrl: "http://localhost:5173/",
			component: "Settings",
			locations: [{ path: "src/Settings.tsx", line: 42 }],
			crop: { type: "image", data: "CROP", mimeType: "image/jpeg" },
		});
		expect(screen.getByRole("status").textContent).toMatch(/<button#save> “保存”/);
		const box = screen.getByTestId("pick-box");
		expect([box.style.left, box.style.top, box.style.width, box.style.height]).toEqual(["25%", "25%", "7.8125%", "5%"]);

		fireEvent.keyDown(document, { key: "Escape" });
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("explains why picking is unavailable instead of failing silently", async () => {
		vi.stubGlobal("fetch", vi.fn(() => json("pi has no page open in its browser for this session", 409)));
		const { messages, tools } = conversation("browser_screenshot");
		render(<ElementPickContext.Provider value={{ sessionId: "c2Vzc2lvbi1pZA", onPick: vi.fn() }}><ChatWindow messages={messages} tools={tools} /></ElementPickContext.Provider>);
		fireEvent.click(screen.getByRole("button", { name: /选元素|Pick element/ }));
		await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/no page open/));
		expect(screen.getByRole("status").getAttribute("data-phase")).toBe("error");
	});
});
