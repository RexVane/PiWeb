import { afterEach, describe, expect, it, vi } from "vitest";

const tab = {
	hasPage: false,
	loadedAt: 0,
	device: "desktop" as const,
	console: [] as Array<{ level: "error" | "warning"; source: string; text: string; url?: string; ts: number }>,
	navigate: vi.fn(async () => {
		tab.hasPage = true;
		tab.loadedAt = 100;
		return { url: "http://localhost:5173/", title: "App" };
	}),
	info: vi.fn(async () => ({ url: "http://localhost:5173/", title: "App" })),
	screenshot: vi.fn(async () => ({ data: "JPEGDATA", width: 1280, height: 800 })),
	evaluate: vi.fn(async () => "Headings:\nh1: Hello"),
	setDevice: vi.fn(async (device: "desktop" | "tablet" | "mobile") => { tab.device = device as never; }),
	click: vi.fn(async () => undefined),
	type: vi.fn(async () => undefined),
};

vi.mock("../src/lib/browser/manager", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/lib/browser/manager")>();
	return { ...actual, getBrowserTab: vi.fn(async () => tab) };
});

import { getBrowserTab } from "../src/lib/browser/manager";
import { BROWSER_TOOL_NAMES, createBrowserTools } from "../src/lib/browser/tools";

const vision = { model: { input: ["text", "image"] } } as never;
const textOnly = { model: { input: ["text"] } } as never;

function tool(name: string) {
	const found = createBrowserTools("session-1").find((t) => t.name === name);
	if (!found) throw new Error(name);
	return (params: Record<string, unknown>, ctx = vision) => found.execute("call-1", params as never, undefined, undefined, ctx);
}

afterEach(() => {
	vi.clearAllMocks();
	tab.hasPage = false;
	tab.loadedAt = 0;
	tab.device = "desktop" as never;
	tab.console.length = 0;
});

describe("browser tools", () => {
	it("exposes the five tools with their names and one prompt guideline", () => {
		const tools = createBrowserTools("s");
		expect(tools.map((t) => t.name)).toEqual([...BROWSER_TOOL_NAMES]);
		expect(tools.filter((t) => t.promptGuidelines?.length)).toHaveLength(1);
	});

	it("refuses public URLs before touching the browser", async () => {
		await expect(tool("browser_open")({ url: "http://8.8.8.8/" })).rejects.toThrow(/public address/);
		expect(getBrowserTab).not.toHaveBeenCalled();
	});

	it("opens a local page and returns the screenshot with a console summary since load", async () => {
		tab.console.push(
			{ level: "error", source: "console", text: "stale error before load", ts: 50 },
			{ level: "error", source: "exception", text: "TypeError: x is undefined", url: "http://localhost:5173/src/App.tsx:12", ts: 150 },
			{ level: "warning", source: "console", text: "deprecated prop", ts: 160 },
		);
		const result = await tool("browser_open")({ url: "localhost:5173", device: "mobile" });
		expect(getBrowserTab).toHaveBeenCalledWith("session-1");
		expect(tab.setDevice).toHaveBeenCalledWith("mobile");
		expect(tab.navigate).toHaveBeenCalledWith("http://localhost:5173/");
		expect(result.content[1]).toEqual({ type: "image", data: "JPEGDATA", mimeType: "image/jpeg" });
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("Page: App — http://localhost:5173/");
		expect(text).toContain("Console: 1 error(s), 1 warning(s) since the page loaded");
		expect(text).toContain("TypeError: x is undefined");
		expect(text).not.toContain("stale error before load");
		expect(result.details).toMatchObject({ errors: 1, warnings: 1, device: "mobile" });
	});

	it("describes the page as text when the model cannot see images", async () => {
		tab.hasPage = true;
		const result = await tool("browser_screenshot")({}, textOnly);
		expect(tab.screenshot).not.toHaveBeenCalled();
		expect(result.content).toHaveLength(1);
		expect((result.content[0] as { text: string }).text).toContain("cannot view images");
		expect((result.content[0] as { text: string }).text).toContain("h1: Hello");
	});

	it("asks for browser_open before looking at, clicking or typing into nothing", async () => {
		for (const name of ["browser_screenshot", "browser_console", "browser_click", "browser_type"]) {
			await expect(tool(name)({ selector: "#x", text: "t" })).rejects.toThrow(/browser_open/);
		}
	});

	it("lists console entries filtered by level and clicks / types before looking again", async () => {
		tab.hasPage = true;
		tab.loadedAt = 100;
		tab.console.push(
			{ level: "error", source: "network", text: "HTTP 404", url: "http://localhost:5173/missing.js", ts: 120 },
			{ level: "warning", source: "console", text: "slow", ts: 130 },
		);
		const errorsOnly = await tool("browser_console")({});
		expect((errorsOnly.content[0] as { text: string }).text).toContain("[error/network] HTTP 404 (http://localhost:5173/missing.js)");
		expect((errorsOnly.content[0] as { text: string }).text).not.toContain("slow");
		const all = await tool("browser_console")({ level: "all" });
		expect((all.content[0] as { text: string }).text).toContain("[warning/console] slow");

		await tool("browser_click")({ selector: "#save" });
		expect(tab.click).toHaveBeenCalledWith({ selector: "#save", x: undefined, y: undefined });
		await tool("browser_type")({ selector: "#name", text: "你好", submit: true });
		expect(tab.type).toHaveBeenCalledWith("#name", "你好", true);
		expect(tab.screenshot).toHaveBeenCalledTimes(2);
	});
});
