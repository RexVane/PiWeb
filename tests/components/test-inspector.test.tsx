// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TestInspectorPod } from "@/components/TestInspectorPod";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function response(data: unknown, ok = true) {
	return { ok, json: async () => ok ? { success: true, data } : { success: false, error: data } };
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((yes) => { resolve = yes; });
	return { promise, resolve };
}

describe("TestInspectorPod", () => {
	it("does not fabricate metrics or claim an execution sandbox before a run", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => response({ files: [], runner: "vitest" })));
		render(<TestInspectorPod cwd="/repo" />);
		expect(await screen.findByText("此工作区没有测试文件。")).toBeTruthy();
		for (const literal of ["94.2%", "88.5%", "48.2 MB", "48211", "48212", "v1.4.0", "第 2 轮", "100% 隔离安全", "Pool: 2", "彻底截断", "0 个文件改动"]) {
			expect(document.body.textContent).not.toContain(literal);
		}
		expect(screen.getByText("覆盖率：未采集")).toBeTruthy();
		expect(screen.getByText("无系统沙盒隔离")).toBeTruthy();
		expect(screen.getByText(/测试继承服务进程环境变量/)).toBeTruthy();
	});
	it("loads actual test files and source, then runs only the selected file", async () => {
		const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
			if (url === "/api/tests?cwd=%2Frepo") return response({ files: ["tests/a.test.ts", "tests/b.spec.ts"], runner: "vitest" });
			if (url.includes("file=tests%2Fa.test.ts")) return response({ file: "tests/a.test.ts", content: "describe('A', () => {});" });
			if (url === "/api/tests" && init?.method === "POST") return response({ file: "tests/a.test.ts", passed: 1, failed: 0, skipped: 0, durationMs: 312, success: true, tests: [{ name: "A works", status: "passed", durationMs: 21 }], output: "" });
			throw new Error(`unexpected request: ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);
		render(<TestInspectorPod cwd="/repo" />);
		expect(await screen.findByText("tests/b.spec.ts")).toBeTruthy();
		expect(await screen.findByText("describe('A', () => {});", { exact: false })).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "运行当前文件" }));
		expect(await screen.findByText(/执行通过 · 1 通过/)).toBeTruthy();
		expect(screen.getByText("A works")).toBeTruthy();
		const post = fetchMock.mock.calls.find(([url, init]) => url === "/api/tests" && init?.method === "POST");
		expect(JSON.parse(String(post?.[1]?.body))).toEqual({ cwd: "/repo", file: "tests/a.test.ts" });
	});

	it("shows backend trust errors instead of a simulated PASS", async () => {
		vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
			if (url === "/api/tests?cwd=%2Frepo") return response({ files: ["tests/a.test.ts"] });
			if (url.includes("file=")) return response({ content: "test('x', () => {})" });
			if (init?.method === "POST") return response("trust this project before running tests", false);
			throw new Error(`unexpected request: ${url}`);
		}));
		render(<TestInspectorPod cwd="/repo" />);
		fireEvent.click(await screen.findByRole("button", { name: "运行当前文件" }));
		expect(await screen.findByRole("alert")).toHaveProperty("textContent", "trust this project before running tests");
		expect(screen.queryByText(/执行通过/)).toBeNull();
	});

	it("ignores a late file catalog from the previous workspace", async () => {
		const old = deferred<ReturnType<typeof response>>();
		vi.stubGlobal("fetch", vi.fn((url: string) => {
			if (url === "/api/tests?cwd=%2Fold") return old.promise;
			if (url === "/api/tests?cwd=%2Fnew") return Promise.resolve(response({ files: ["tests/new.test.ts"] }));
			if (url.includes("new.test.ts")) return Promise.resolve(response({ content: "new source" }));
			throw new Error(`unexpected request: ${url}`);
		}));
		const { rerender } = render(<TestInspectorPod cwd="/old" />);
		rerender(<TestInspectorPod cwd="/new" />);
		expect(await screen.findByRole("heading", { name: "tests/new.test.ts" })).toBeTruthy();
		await act(async () => old.resolve(response({ files: ["tests/old.test.ts"] })));
		expect(screen.queryByText("tests/old.test.ts")).toBeNull();
		expect(screen.getByRole("heading", { name: "tests/new.test.ts" })).toBeTruthy();
	});

	it("does not offer a run without a selected workspace", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		render(<TestInspectorPod cwd="" />);
		expect(screen.getByText(/请先在工作台选择工作区/)).toBeTruthy();
		await waitFor(() => expect(fetchMock).not.toHaveBeenCalled());
	});
});
