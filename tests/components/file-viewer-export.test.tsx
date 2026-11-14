// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FileViewer } from "@/components/FileViewer";
import type { GrowthApi } from "@/hooks/useGrowth";

const clipboard = vi.hoisted(() => ({ copyText: vi.fn(async (_text: string) => true) }));
vi.mock("@/lib/clipboard", () => clipboard);
afterEach(() => { cleanup(); vi.unstubAllGlobals(); clipboard.copyText.mockClear(); });
const response = (data: unknown) => ({ ok: true, status: 200, json: async () => ({ success: true, data }) });
function growth(overrides: Partial<GrowthApi> = {}): GrowthApi {
	return {
		tree: { path: "", name: "", kind: "dir", children: [], counts: { added: 0, modified: 0, deleted: 0, renamed: 0, pending: 0 } },
		expanded: new Set(), fresh: new Set(), filePaths: [], changes: [], rounds: [], selected: null, range: null,
		loading: false, available: true, error: null, scope: "round",
		revealPath: vi.fn(), toggleDir: vi.fn(), expandAll: vi.fn(), collapseAll: vi.fn(), expandLazy: vi.fn(async () => {}),
		selectLatest: vi.fn(), select: vi.fn(), prev: vi.fn(), next: vi.fn(), setScope: vi.fn(), refresh: vi.fn(async () => {}), recordNow: vi.fn(async () => null),
		...overrides,
	};
}
const callbacks = () => ({ onClose: vi.fn(), onSelectTab: vi.fn(), onCloseTab: vi.fn(), onOpen: vi.fn() });
it.each([false, true])("copies the %s-truncated disk content with an accurate label and full current-file download URL", async (truncated) => {
	const cwd = "/export-disk-" + truncated, file = "中文 notes.txt", content = "中文 😀\npreview";
	vi.stubGlobal("fetch", vi.fn(async () => response({ content, binary: false, truncated })));
	render(<FileViewer growth={growth()} cwd={cwd} state={{ open: true, tabs: [{ path: file, lazy: true }], active: file }} {...callbacks()} />);
	const copy = await screen.findByRole("button", { name: truncated ? "复制预览" : "复制全文" });
	await waitFor(() => expect((copy as HTMLButtonElement).disabled).toBe(false)); fireEvent.click(copy);
	await waitFor(() => expect(clipboard.copyText).toHaveBeenCalledWith(content));
	const download = screen.getByRole("link", { name: "下载当前文件" }) as HTMLAnchorElement;
	const query = new URL(download.href).searchParams; expect(query.get("cwd")).toBe(cwd); expect(query.get("path")).toBe(file); expect(download.hasAttribute("download")).toBe(true);
});
it("displays unsupported encoding instead of an empty code preview and retains original-file download", async () => {
	vi.stubGlobal("fetch", vi.fn(async () => response({ content: "", binary: false, truncated: false, encodingUnsupported: true })));
	const view = render(<FileViewer growth={growth()} cwd="/export-gbk" state={{ open: true, tabs: [{ path: "gbk.txt", lazy: true }], active: "gbk.txt" }} {...callbacks()} />);
	await screen.findByText(/文件编码暂不支持，无法可靠预览/); expect(view.container.querySelector("pre code")).toBeNull();
	expect((screen.getByRole("button", { name: "复制全文" }) as HTMLButtonElement).disabled).toBe(true);
	expect(screen.getByRole("link", { name: "下载当前文件" })).toBeTruthy();
});
it.each([false, true])("copies the original %s-truncated patch including file/hunk headers and ASCII signs", async (truncated) => {
	const patch = "diff --git a/a.ts b/a.ts\nindex 111..222 100644\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old line\n+new line\n";
	vi.stubGlobal("fetch", vi.fn(async () => response({ patch, binary: false, truncated })));
	const view = render(<FileViewer growth={growth({ range: { from: "before", to: "after" }, changes: [{ path: "a.ts", status: "M", add: 1, del: 1 }] })}
		cwd={"/export-patch-" + truncated} state={{ open: true, tabs: [{ path: "a.ts" }], active: "a.ts" }} {...callbacks()} />);
	const copy = await screen.findByRole("button", { name: truncated ? "复制差异预览" : "复制差异" }); fireEvent.click(copy);
	await waitFor(() => expect(clipboard.copyText).toHaveBeenCalledWith(patch));
	expect(Array.from(view.container.querySelectorAll(".pw-fdiff-sign")).map((span) => span.textContent)).toEqual(expect.arrayContaining(["-", "+"]));
});
it("switches a snapshot from patch copy to full-content copy without reusing the retained patch", async () => {
	const patch = "--- a/switch.ts\n+++ b/switch.ts\n@@ -1 +1 @@\n-old\n+new\n", content = "new\nother unchanged content\n";
	vi.stubGlobal("fetch", vi.fn(async (url: string) => response(url.includes("content=1") ? { content, binary: false, truncated: false } : { patch, binary: false, truncated: false })));
	render(<FileViewer growth={growth({ range: { from: "before", to: "after" }, changes: [{ path: "switch.ts", status: "M", add: 1, del: 1 }] })}
		cwd="/export-mode-switch" state={{ open: true, tabs: [{ path: "switch.ts" }], active: "switch.ts" }} {...callbacks()} />);
	fireEvent.click(await screen.findByRole("button", { name: "复制差异" })); await waitFor(() => expect(clipboard.copyText).toHaveBeenLastCalledWith(patch));
	fireEvent.click(screen.getByRole("radio", { name: "内容" }));
	const copy = await screen.findByRole("button", { name: "复制全文" }); await waitFor(() => expect((copy as HTMLButtonElement).disabled).toBe(false)); fireEvent.click(copy);
	await waitFor(() => expect(clipboard.copyText).toHaveBeenLastCalledWith(content)); expect(screen.queryByRole("button", { name: "复制差异" })).toBeNull();
});
