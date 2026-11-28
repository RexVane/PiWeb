// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ProxySettings } from "@/components/ProxySettings";

const automatic = {
	source: "system",
	http: "http://127.0.0.1:7897",
	https: "http://127.0.0.1:7897",
	detected: [{ url: "http://127.0.0.1:7897", source: "system" }],
};
const response = (data: unknown) => ({ ok: true, json: async () => ({ success: true, data }) });
const props = { value: "", disabled: false, onChange: vi.fn(), onCommit: vi.fn() };
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("proxy settings", () => {
	it("defaults to system proxy with detected label and tests without saving an override", async () => {
		const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => response(init?.method === "POST"
			? { automatic, test: { proxy: automatic, ok: true, latencyMs: 123, status: 204 } } : automatic));
		vi.stubGlobal("fetch", fetchMock);
		render(<ProxySettings {...props} />);
		const trigger = await screen.findByRole("button", { name: "网络代理" });
		await waitFor(() => expect(trigger.textContent).toContain("系统代理 (127.0.0.1:7897)"));
		expect(screen.queryByRole("textbox")).toBeNull();
		expect(props.onChange).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole("button", { name: "测试连接" }));
		expect((await screen.findByRole("status")).textContent).toContain("外网连通 · 123 ms");
		expect(fetchMock.mock.calls.find((call) => call[1]?.method === "POST")?.[1]?.body).toBe('{"proxy":""}');
		expect(props.onCommit).not.toHaveBeenCalled();
	});

	it("switches immediately to direct or detected proxy presets and tests direct mode", async () => {
		const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => response(init?.method === "POST"
			? { automatic, test: { proxy: { source: "direct", http: null, https: null }, ok: true, latencyMs: 42, status: 204 } } : automatic));
		vi.stubGlobal("fetch", fetchMock);
		const onCommit = vi.fn();
		function Harness() {
			const [value, setValue] = useState("");
			return <ProxySettings value={value} disabled={false} onChange={setValue} onCommit={onCommit} />;
		}
		render(<Harness />);
		await waitFor(() => expect(screen.getByRole("button", { name: "网络代理" }).textContent).toContain("127.0.0.1:7897"));

		fireEvent.click(screen.getByRole("button", { name: "网络代理" }));
		fireEvent.click(screen.getByRole("option", { name: "直连" }));
		expect(onCommit).toHaveBeenCalledWith("direct");
		expect(screen.getByRole("button", { name: "网络代理" }).textContent).toContain("直连");

		fireEvent.click(screen.getByRole("button", { name: "测试连接" }));
		expect((await screen.findByRole("status")).textContent).toContain("外网连通 · 42 ms");
		expect(fetchMock.mock.calls.find((call) => call[1]?.method === "POST")?.[1]?.body).toBe('{"proxy":"direct"}');

		fireEvent.click(screen.getByRole("button", { name: "网络代理" }));
		fireEvent.click(screen.getByRole("option", { name: "http://127.0.0.1:7897 (系统)" }));
		expect(onCommit).toHaveBeenLastCalledWith("http://127.0.0.1:7897");
	});

	it("reveals custom input when Custom is picked, tests draft, and clears stale results", async () => {
		const onCommit = vi.fn();
		let finish: (value: unknown) => void = () => {};
		const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => init?.method === "POST"
			? new Promise((resolve) => { finish = resolve; }) : response(automatic));
		vi.stubGlobal("fetch", fetchMock);

		function Harness() {
			const [value, setValue] = useState("");
			return <ProxySettings value={value} disabled={false} onChange={setValue} onCommit={onCommit} />;
		}
		const view = render(<Harness />);
		await waitFor(() => expect(screen.getByRole("button", { name: "网络代理" }).textContent).toContain("127.0.0.1:7897"));

		fireEvent.click(screen.getByRole("button", { name: "网络代理" }));
		fireEvent.click(screen.getByRole("option", { name: "自定义" }));
		const input = screen.getByRole("textbox", { name: "网络代理" }) as HTMLInputElement;
		expect(input.value).toBe("");

		fireEvent.change(input, { target: { value: "http://manual:8080" } });
		const testBtn = screen.getByRole("button", { name: "测试连接" });
		fireEvent.blur(input, { relatedTarget: testBtn });
		expect(onCommit).not.toHaveBeenCalled();

		fireEvent.click(testBtn);
		expect(screen.getByRole("button", { name: "正在测试…" }).hasAttribute("disabled")).toBe(true);
		expect(fetchMock.mock.calls.find((call) => call[1]?.method === "POST")?.[1]?.body).toBe('{"proxy":"http://manual:8080"}');

		view.rerender(<ProxySettings {...props} value="http://changed:8080" />);
		finish(response({ automatic, test: { proxy: automatic, ok: true, latencyMs: 12 } }));
		await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
	});

	it("keeps the row quiet and disables testing when system proxy is selected with none detected, while enabling direct test", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => response({ source: "none", http: null, https: null, detected: [] })));
		render(<ProxySettings {...props} />);
		await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
		expect(screen.getByRole("button", { name: "网络代理" }).textContent).toContain("系统代理");
		expect(screen.getByRole("button", { name: "测试连接" }).hasAttribute("disabled")).toBe(true);
		expect(screen.queryByText("未检测到代理")).toBeNull();
		expect(screen.queryByRole("status")).toBeNull();
	});

	it("keeps custom testing available without showing automatic-read failures", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
		render(<ProxySettings {...props} value="http://manual:8080" />);
		await waitFor(() => expect(screen.getByRole("button", { name: "测试连接" }).hasAttribute("disabled")).toBe(false));
		expect(screen.queryByText("默认代理读取失败")).toBeNull();
		expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("http://manual:8080");
	});
});
