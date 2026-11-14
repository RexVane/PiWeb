// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SessionSidebar } from "@/components/SessionSidebar";
import type { SessionListItem } from "@/hooks/usePiWeb";
afterEach(() => { cleanup(); sessionStorage.clear(); });
const item = (path: string, name: string): SessionListItem => ({
	path, name, cwd: "/parent/workspace", firstMessage: "", messageCount: 1, streaming: false,
	created: "2026-11-01T00:00:00Z", modified: "2026-11-12T00:00:00Z",
});
const props = () => ({
	addedWorkspaces: ["/parent/workspace"], currentPath: null, groupBy: "flat" as const, orderBy: "updated" as const,
	setGroupBy: vi.fn(), setOrderBy: vi.fn(), collapsed: false, onToggleCollapse: vi.fn(), onOpen: vi.fn(),
	onNew: vi.fn(), onNewInWorkspace: vi.fn(), onRename: vi.fn(async () => {}), onOpenSettings: vi.fn(), onAddWorkspace: vi.fn(),
});
it("renders the registry recovery warning independently of session-list errors", () => {
	render(<SessionSidebar {...props()} sessions={[]} workspaceRegistryWarning="损坏记录已备份并恢复，请检查别名和置顶。" />);
	expect(screen.getByRole("status").textContent).toBe("损坏记录已备份并恢复，请检查别名和置顶。");
});
it("coalesces rapid search edits and clears the pending search when closed", async () => {
	const search = vi.fn();
	render(<SessionSidebar {...props()} sessions={[]} onSearchQuery={search} />);
	fireEvent.click(screen.getByTitle("搜索"));
	const input = screen.getByPlaceholderText("搜索会话...");
	for (const value of ["a", "ab", "abc"]) fireEvent.change(input, { target: { value } });
	expect(search.mock.calls.filter(([query]) => query)).toEqual([]);
	await waitFor(() => expect(search).toHaveBeenLastCalledWith("abc"));
	expect(search.mock.calls.filter(([query]) => query)).toEqual([["abc"]]);
	fireEvent.change(input, { target: { value: "abcd" } });
	fireEvent.keyDown(input, { key: "Escape" });
	await new Promise((resolve) => setTimeout(resolve, 350));
	expect(search).toHaveBeenLastCalledWith("");
});
it("server search uses supplied matches including archived sessions, without filtering them a second time", async () => {
	const search = vi.fn();
	const page = [item("/sessions/a.jsonl", "server selected archive")];
	render(<SessionSidebar {...props()} sessions={page} archivedPaths={[page[0].path]} onSearchQuery={search} />);
	fireEvent.click(screen.getByTitle("搜索"));
	fireEvent.change(screen.getByPlaceholderText("搜索会话..."), { target: { value: "full body query" } });
	await waitFor(() => expect(search).toHaveBeenLastCalledWith("full body query"));
	expect(screen.getByText("server selected archive")).toBeTruthy();
});
it("local search includes archive matches and full workspace paths", () => {
	render(<SessionSidebar {...props()} sessions={[]} archivedSessions={[item("/sessions/archive.jsonl", "archived match")]} />);
	fireEvent.click(screen.getByTitle("搜索"));
	fireEvent.change(screen.getByPlaceholderText("搜索会话..."), { target: { value: "/parent/" } });
	expect(screen.getByText("archived match")).toBeTruthy();
});
it("load-more action remains visible for paged search results and cannot be repeated while loading", () => {
	const more = vi.fn();
	const shared = props();
	const view = render(<SessionSidebar {...shared} sessions={[item("/a", "first page")]} hasMore onLoadMore={more} />);
	const button = screen.getByRole("button", { name: "加载更多" });
	fireEvent.click(button);
	expect(more).toHaveBeenCalledTimes(1);
	view.rerender(<SessionSidebar {...shared} sessions={[item("/a", "first page")]} hasMore loadingMore onLoadMore={more} />);
	const pending = screen.getByRole("button", { name: "加载中…" });
	expect((pending as HTMLButtonElement).disabled).toBe(true);
	fireEvent.click(pending);
	expect(more).toHaveBeenCalledTimes(1);
});
