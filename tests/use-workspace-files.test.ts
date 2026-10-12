// @vitest-environment jsdom
/**
 * @ 候选清单的拉取：同一工作区并发只发一次请求。
 * 回归：共享请求原来挂着第一个调用方的 AbortSignal，第一个输入框一卸载，后来的也跟着拿到 AbortError、显示成错误。
 * 清单按工作区缓存在模块级 Map 里，每个用例用不同的 cwd。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { useWorkspaceFiles } from "@/hooks/useWorkspaceFiles";

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

function deferredIndex() {
	const calls: { url: string; init?: RequestInit; resolve: (files: string[]) => void }[] = [];
	vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => new Promise((resolve) => {
		calls.push({
			url,
			init,
			resolve: (files) => resolve({ ok: true, status: 200, json: async () => ({ success: true, data: { files, source: "git", truncated: false } }) }),
		});
	})));
	return calls;
}

describe("useWorkspaceFiles", () => {
	it("两个输入框同时打开只拉一次；先打开的那个关了，后来的照样拿到清单", async () => {
		const calls = deferredIndex();
		const first = renderHook(() => useWorkspaceFiles("/ws-shared", true));
		const second = renderHook(() => useWorkspaceFiles("/ws-shared", true));
		expect(calls).toHaveLength(1);
		expect(calls[0].init?.signal).toBeUndefined();

		first.unmount();
		await act(async () => calls[0].resolve(["src/a.ts"]));
		await waitFor(() => expect(second.result.current.status).toBe("ready"));
		expect(second.result.current.candidates.map((candidate) => candidate.path).sort()).toEqual(["src", "src/a.ts"]);
	});

	it("没开候选或没有工作区时不拉", () => {
		const calls = deferredIndex();
		renderHook(() => useWorkspaceFiles("/ws-idle", false));
		renderHook(() => useWorkspaceFiles("", true));
		expect(calls).toHaveLength(0);
	});
});
