// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { GitPanel } from "@/components/GitPanel";

const highlighting = vi.hoisted(() => ({ highlightLine: vi.fn((text: string) => text), languageForPath: () => "typescript" }));
const clipboard = vi.hoisted(() => ({ copyText: vi.fn(async (_text: string) => true) }));
vi.mock("@/lib/highlight", () => highlighting);
vi.mock("@/lib/clipboard", () => clipboard);
afterEach(() => { cleanup(); vi.unstubAllGlobals(); highlighting.highlightLine.mockClear(); clipboard.copyText.mockClear(); });
const response = (data: unknown) => ({ ok: true, json: async () => ({ success: true, data }) });
const info = { available: true, isRepo: true, root: "/repo", branch: "main", upstream: null, ahead: 0, behind: 0, detached: false,
	files: [{ path: "large.ts", kind: "modified", indexStatus: " ", workStatus: "M" }], commits: [] };
it("windows the actual GitPanel large diff, highlights only visible rows and preserves raw patch copy", async () => {
	const patch = "diff --git a/large.ts b/large.ts\n--- a/large.ts\n+++ b/large.ts\n@@ -1 +1,2001 @@\n-old line\n" + Array.from({ length: 2001 }, (_, i) => "+added_" + i + (i === 500 ? " long".repeat(1000) : "")).join("\n") + "\n";
	vi.stubGlobal("fetch", vi.fn(async (url: string) => response(url.includes("diff=") ? { patch, binary: false, truncated: true } : info)));
	const view = render(<GitPanel cwd="/repo" onClose={vi.fn()} />); fireEvent.click(await screen.findByTitle("large.ts"));
	const viewport = await screen.findByTestId("diff-viewport"); const rows = () => view.container.querySelectorAll(".pw-diff-row");
	expect(rows().length).toBeLessThan(80); expect(highlighting.highlightLine.mock.calls.length).toBeLessThan(100);
	expect(viewport.style.whiteSpace).toBe("pre"); expect(viewport.style.overflow).toBe("auto"); expect(screen.getByText("old line", { exact: false })).toBeTruthy();
	const deletion = view.container.querySelector('.pw-diff-row[data-kind="del"]')!; expect(deletion.children[1].textContent).toBe("-"); expect((deletion.children[1] as HTMLElement).style.userSelect).toBe("text");
	fireEvent.scroll(viewport, { target: { scrollTop: 500 * 18 } });
	await waitFor(() => expect(screen.getByText("added_500", { exact: false })).toBeTruthy()); expect(screen.queryByText("old line", { exact: false })).toBeNull(); expect(rows().length).toBeLessThan(80);
	fireEvent.scroll(viewport, { target: { scrollTop: 10_000_000 } }); await waitFor(() => expect(screen.getByText("added_2000", { exact: false })).toBeTruthy()); expect(rows().length).toBeLessThan(80);
	fireEvent.click(screen.getByRole("button", { name: "复制差异预览" })); await waitFor(() => expect(clipboard.copyText).toHaveBeenCalledWith(patch));
});
