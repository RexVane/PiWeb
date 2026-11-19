// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { FileViewer } from "@/components/FileViewer";
import type { GrowthApi } from "@/hooks/useGrowth";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function showFile(code: string, message: string, status = 400) {
	const fetchMock = vi.fn(async (_url: RequestInfo | URL) => ({ ok: false, status, json: async () => ({ success: false, errorCode: code, error: message }) }));
	vi.stubGlobal("fetch", fetchMock);
	const growth = { rounds: [], range: null, selected: null, changes: [], filePaths: [], tree: { path: "", name: "", kind: "dir", children: [] } } as unknown as GrowthApi;
	render(<FileViewer state={{ open: true, tabs: [{ path: "C:/other/clash-verge-aifix.yaml", lazy: true }], active: "C:/other/clash-verge-aifix.yaml" }}
		growth={growth} cwd="D:/viewer-error-codes" onClose={vi.fn()} onSelectTab={vi.fn()} onCloseTab={vi.fn()} onOpen={vi.fn()} />);
	return fetchMock;
}

function expectOnlyFileReads(fetchMock: ReturnType<typeof showFile>) {
	expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
	// Lazy tabs switch from diff to content once on mount, so reads can occur twice.
	// The regression is an unnecessary directory probe, not the mode switch.
	for (const [url] of fetchMock.mock.calls) expect(String(url)).toContain("read=1");
}

it("shows outside-workspace rather than missing for an existing inaccessible file", async () => {
	const fetchMock = showFile("OUT_OF_WORKSPACE", "path escapes the workspace");
	expect((await screen.findAllByText("此文件在工作区之外，无法预览")).length).toBeGreaterThan(0);
	expect(screen.queryByText("此文件已不在当前快照或磁盘中")).toBeNull();
	expectOnlyFileReads(fetchMock);
});

it("shows missing only for an actual NOT_FOUND response", async () => {
	const fetchMock = showFile("NOT_FOUND", "file not found");
	expect((await screen.findAllByText("此文件已不在当前快照或磁盘中")).length).toBeGreaterThan(0);
	expectOnlyFileReads(fetchMock);
});

it.each([["VALIDATION_ERROR", "invalid file path", 400], ["EACCES", "permission denied", 500]])("does not disguise %s as a missing file", async (code, message, status) => {
	const fetchMock = showFile(code, message, status);
	expect(await screen.findByText(message)).toBeTruthy();
	expect(screen.queryByText("此文件已不在当前快照或磁盘中")).toBeNull();
	expectOnlyFileReads(fetchMock);
});
