// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ProxySettings } from "@/components/ProxySettings";

const automatic = { source: "system", http: "http://127.0.0.1:7897", https: "http://127.0.0.1:7897" };
const response = (data: unknown) => ({ ok: true, json: async () => ({ success: true, data }) });
const props = { value: "", disabled: false, onChange: vi.fn(), onCommit: vi.fn() };
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("proxy settings", () => {
	it("shows the detected address without saving it as a manual override and tests it", async () => {
		const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => response(init?.method === "POST"
			? { automatic, test: { proxy: automatic, ok: true, latencyMs: 123, status: 204 } } : automatic));
		vi.stubGlobal("fetch", fetchMock);
		render(<ProxySettings {...props} />);
		expect(await screen.findByText(automatic.https)).toBeTruthy();
		expect((screen.getByRole("textbox", { name: "手动代理地址" }) as HTMLInputElement).value).toBe("");
		fireEvent.click(screen.getByRole("button", { name: "测试连接" }));
		expect((await screen.findByRole("status")).textContent).toContain("外网连通 · 123 ms");
		expect(fetchMock.mock.calls.find((call) => call[1]?.method === "POST")?.[1]?.body).toBe('{"proxy":""}');
		expect(props.onCommit).not.toHaveBeenCalled();
	});

	it("tests a manual draft and shows a useful failure", async () => {
		const onCommit = vi.fn();
		const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => response(init?.method === "POST"
			? { automatic, test: { proxy: automatic, ok: false, latencyMs: 8000, code: "timeout" } } : automatic));
		vi.stubGlobal("fetch", fetchMock);
		render(<ProxySettings {...props} value="http://manual:8080" onCommit={onCommit} />);
		await screen.findByText(automatic.https);
		const button = screen.getByRole("button", { name: "测试连接" });
		fireEvent.blur(screen.getByRole("textbox"), { relatedTarget: button });
		fireEvent.click(button);
		expect((await screen.findByRole("status")).textContent).toContain("连接超时");
		expect(onCommit).not.toHaveBeenCalled();
		expect(fetchMock.mock.calls.find((call) => call[1]?.method === "POST")?.[1]?.body).toBe('{"proxy":"http://manual:8080"}');
	});

	it("clears stale results when the address changes during a test", async () => {
		let finish: (value: unknown) => void = () => {};
		vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => init?.method === "POST"
			? new Promise((resolve) => { finish = resolve; }) : response(automatic)));
		const view = render(<ProxySettings {...props} />);
		await screen.findByText(automatic.https);
		fireEvent.click(screen.getByRole("button", { name: "测试连接" }));
		expect(screen.getByRole("button", { name: "正在测试…" }).hasAttribute("disabled")).toBe(true);
		view.rerender(<ProxySettings {...props} value="http://changed:8080" />);
		finish(response({ automatic, test: { proxy: automatic, ok: true, latencyMs: 12 } }));
		await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
	});

	it("can reread a changed system proxy and disables testing when no proxy is detected", async () => {
		let data: unknown = automatic;
		vi.stubGlobal("fetch", vi.fn(async () => response(data)));
		render(<ProxySettings {...props} />);
		await screen.findByText(automatic.https);
		data = { source: "none", http: null, https: null };
		fireEvent.click(screen.getByRole("button", { name: "重新读取代理" }));
		expect(await screen.findByText("未检测到代理")).toBeTruthy();
		expect(screen.getByRole("button", { name: "测试连接" }).hasAttribute("disabled")).toBe(true);
	});
});
