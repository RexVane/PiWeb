// @vitest-environment jsdom
import { useRef, useState } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ProjectOverview, ProjectOverviewPanel, ProjectOverviewToggle } from "@/components/ProjectOverview";
import { EMPTY_CHAT_DRAFT } from "@/components/ChatInput";

function renderOverview() {
	render(<ProjectOverview cwd="/workspace" name="Workspace" draftKey="chat" messages={[]} tools={{}} refreshKey={0}
		draftStore={{ subscribe: () => () => {}, get: () => EMPTY_CHAT_DRAFT }}
		hasEarlier={false} loadingEarlier={false} onLoadEarlier={vi.fn()} onOpenChanges={vi.fn()}
		onOpenFile={vi.fn()} onOpenUpload={vi.fn()} onAddLink={vi.fn()} onPickFiles={vi.fn()} />);
	return screen.getByRole("button", { name: /项目概览|Project overview/ });
}

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it("polls line totals and untracked counts without a file list, only while open", async () => {
	vi.useFakeTimers();
	const data = { available: true, isRepo: true, lineStats: { add: 0, del: 0 }, counts: { untracked: 24_000 } };
	const fetchMock = vi.fn().mockImplementation(async () => ({ ok: true, json: async () => ({ success: true, data }) }));
	vi.stubGlobal("fetch", fetchMock);
	const toggle = renderOverview();
	expect(fetchMock).not.toHaveBeenCalled();
	await act(async () => { fireEvent.click(toggle); });
	const changes = screen.getByRole("button", { name: /变更|Changes/ });
	expect(fetchMock.mock.calls[0][0]).toContain("summary=lines");
	expect(changes.textContent).toMatch(/\+0\s*−0.*24000/);
	data.lineStats = { add: 3, del: 1 };
	await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
	expect(changes.textContent).toMatch(/\+3\s*−1/);
	fireEvent.click(toggle);
	await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
	expect(fetchMock).toHaveBeenCalledTimes(2);
});

it.each(["status", "request"])("describes a %s failure without showing zero changes", async (kind) => {
	vi.stubGlobal("fetch", kind === "status"
		? vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true, data: { available: true, isRepo: true, statusError: "index file corrupt" } }) })
		: vi.fn().mockRejectedValue(new Error("request failed")));
	fireEvent.click(renderOverview());
	const error = await screen.findByRole("button", { name: /Git 状态读取失败|Git status unavailable/ });
	expect(error.title).toBe(kind === "status" ? "index file corrupt" : "request failed");
	expect(error.textContent).not.toContain("+0");
});

function PanelHarness({ mode, live = false }: { mode: "docked" | "overlay"; live?: boolean }) {
	const [open, setOpen] = useState(true);
	const triggerRef = useRef<HTMLButtonElement>(null);
	return (
		<div>
			<button type="button">outside</button>
			<ProjectOverviewToggle open={open} controlsId="overview-panel" triggerRef={triggerRef} onToggle={() => setOpen((v) => !v)} />
			<ProjectOverviewPanel
				id="overview-panel"
				open={open}
				mode={mode}
				triggerRef={triggerRef}
				onClose={() => setOpen(false)}
				cwd=""
				name="Workspace"
				draftKey="chat"
				messages={[{ role: "user", content: [{ type: "text", text: "https://example.com/docs" }] }]}
				tools={{ shell: { name: "bash", args: { command: "sleep 30" }, state: "running" } }}
				live={live}
				refreshKey={0}
				draftStore={{ subscribe: () => () => {}, get: () => EMPTY_CHAT_DRAFT }}
				hasEarlier={false}
				loadingEarlier={false}
				onLoadEarlier={vi.fn()}
				onOpenChanges={vi.fn()}
				onOpenFile={vi.fn()}
				onOpenUpload={vi.fn()}
				onAddLink={vi.fn()}
				onPickFiles={vi.fn()}
			/>
		</div>
	);
}

it("stays open on outside pointerdown/focusin in docked mode and respects Escape unless an aria-modal dialog is open", () => {
	render(<PanelHarness mode="docked" />);
	const rail = screen.getByTestId("project-overview-rail");
	expect(rail.getAttribute("data-mode")).toBe("docked");
	const outside = screen.getByRole("button", { name: "outside" });
	fireEvent.pointerDown(outside);
	fireEvent.focusIn(outside);
	expect(screen.getByRole("dialog", { name: /项目概览|Project overview/ })).toBeTruthy();

	const modal = document.createElement("div");
	modal.setAttribute("aria-modal", "true");
	document.body.appendChild(modal);
	fireEvent.keyDown(document, { key: "Escape" });
	expect(screen.getByRole("dialog", { name: /项目概览|Project overview/ })).toBeTruthy();
	modal.remove();

	fireEvent.keyDown(document, { key: "Escape" });
	expect(screen.queryByRole("dialog", { name: /项目概览|Project overview/ })).toBeNull();
	expect(document.activeElement).toBe(screen.getByRole("button", { name: /项目概览|Project overview/ }));
});

it("closes on outside pointerdown in overlay mode", () => {
	render(<PanelHarness mode="overlay" />);
	const rail = screen.getByTestId("project-overview-rail");
	expect(rail.getAttribute("data-mode")).toBe("overlay");
	fireEvent.pointerDown(screen.getByRole("button", { name: "outside" }));
	expect(screen.queryByRole("dialog", { name: /项目概览|Project overview/ })).toBeNull();
});

it.each(["docked", "overlay"] as const)("opens source details from a %s overview and returns to it with Escape", (mode) => {
	const { rerender } = render(<PanelHarness mode={mode} live />);
	expect(screen.getByText("sleep 30")).toBeTruthy();
	const all = screen.getByRole("button", { name: "查看全部来源" });
	all.focus();
	fireEvent.click(all);
	const details = screen.getByRole("dialog", { name: "会话来源" });
	expect(within(details).getByText("在对话中提供")).toBeTruthy();
	expect(within(details).getByText("https://example.com/docs")).toBeTruthy();
	fireEvent.keyDown(document, { key: "Escape" });
	expect(screen.queryByRole("dialog", { name: "会话来源" })).toBeNull();
	expect(document.activeElement).toBe(all);
	rerender(<PanelHarness mode={mode} />);
	expect(screen.queryByText("后台进程")).toBeNull();
});
