// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ProxySettings } from "@/components/ProxySettings";

const automatic = { source: "system", http: "http://127.0.0.1:7897", https: "http://127.0.0.1:7897" };
const response = (data: unknown) => ({ ok: true, json: async () => ({ success: true, data }) });
const props = { value: "", disabled: false, onChange: vi.fn(), onCommit: vi.fn() };
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("proxy settings", () => {
	it("shows the detected address without saving it as a manual override and tests it", async () => {
		const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => response(init?.method === "POST"
			? { automatic, test: { proxy: automatic, ok: true, latencyMs: 123, status: 204 } } : automatic));
		vi.stubGlobal("fetch", fetchMock);
		render(<ProxySettings {...props} />);
		await waitFor(() => expect((screen.getByRole("textbox", { name: "网络代理" }) as HTMLInputElement).value).toBe(automatic.https));
		expect(props.onChange).not.toHaveBeenCalled();
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
		await waitFor(() => expect(screen.getByRole("button", { name: "测试连接" }).hasAttribute("disabled")).toBe(false));
		expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("http://manual:8080");
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
		await waitFor(() => expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe(automatic.https));
		fireEvent.click(screen.getByRole("button", { name: "测试连接" }));
		expect(screen.getByRole("button", { name: "正在测试…" }).hasAttribute("disabled")).toBe(true);
		view.rerender(<ProxySettings {...props} value="http://changed:8080" />);
		finish(response({ automatic, test: { proxy: automatic, ok: true, latencyMs: 12 } }));
		await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
	});

	it("keeps an empty draft editable and restores the automatic address on blur", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => response(automatic)));
		const onCommit = vi.fn();
		function Editable() {
			const [value, setValue] = useState("http://manual:8080");
			return <ProxySettings {...props} value={value} onChange={setValue} onCommit={onCommit} />;
		}
		render(<Editable />);
		await waitFor(() => expect(screen.getByRole("button", { name: "测试连接" }).hasAttribute("disabled")).toBe(false));
		const input = screen.getByRole("textbox") as HTMLInputElement;
		fireEvent.change(input, { target: { value: "" } });
		expect(input.value).toBe("");
		fireEvent.blur(input);
		expect(input.value).toBe(automatic.https);
		expect(onCommit).toHaveBeenCalledOnce();
	});

	it("keeps the row quiet and disables testing when no proxy is detected", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => response({ source: "none", http: null, https: null })));
		render(<ProxySettings {...props} />);
		await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
		expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("");
		expect(screen.getByRole("button", { name: "测试连接" }).hasAttribute("disabled")).toBe(true);
		expect(screen.getAllByRole("button")).toHaveLength(1);
		expect(screen.queryByText("未检测到代理")).toBeNull();
		expect(screen.queryByRole("status")).toBeNull();
	});

	it("keeps manual testing available without showing automatic-read failures", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
		render(<ProxySettings {...props} value="http://manual:8080" />);
		await waitFor(() => expect(screen.getByRole("button", { name: "测试连接" }).hasAttribute("disabled")).toBe(false));
		expect(screen.queryByText("默认代理读取失败")).toBeNull();
		expect(screen.getAllByRole("button")).toHaveLength(1);
	});
});
