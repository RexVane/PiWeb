// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SessionSidebar } from "@/components/SessionSidebar";
import { I18nProvider } from "@/i18n";
import type { SessionListItem } from "@/hooks/usePiWeb";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-11-15T06:30:00.000Z");
const item = (path: string, name: string, modified = NOW - 3 * DAY): SessionListItem => ({
	path, name, cwd: "/work", firstMessage: "", messageCount: 1, streaming: false,
	created: new Date(NOW - 90 * DAY).toISOString(), modified: new Date(modified).toISOString(),
});
const shared = () => ({
	addedWorkspaces: ["/work"], currentPath: null, groupBy: "flat" as const, orderBy: "updated" as const,
	setGroupBy: vi.fn(), setOrderBy: vi.fn(), collapsed: false, onToggleCollapse: vi.fn(), onOpen: vi.fn(),
	onNew: vi.fn(), onNewInWorkspace: vi.fn(), onRename: vi.fn(async () => {}), onOpenSettings: vi.fn(), onAddWorkspace: vi.fn(),
});
const openArchive = () => fireEvent.click(screen.getByRole("button", { name: /^已归档/ }));

beforeEach(() => {
	localStorage.clear();
	sessionStorage.clear();
	vi.spyOn(Date, "now").mockReturnValue(NOW);
});
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	localStorage.clear();
	sessionStorage.clear();
});

describe("sidebar archive display and ordering", () => {
	it("omits archive duration labels while regular sessions keep showing update age", () => {
		const archived = item("/sessions/archive.jsonl", "archived history", NOW - 45 * DAY);
		const ordinary = item("/sessions/ordinary.jsonl", "ordinary history");
		const archivedAt = NOW - 3 * DAY;
		const props = { ...shared(), sessions: [ordinary], archivedSessions: [archived], archivedPaths: [archived.path], archivedAt: { [archived.path]: archivedAt } };
		const view = render(<SessionSidebar {...props} />);
		openArchive();
		expect(screen.getByText("archived history")).toBeTruthy();
		expect(screen.queryByText("已归档 3天")).toBeNull();
		expect(screen.queryByText("刚刚归档")).toBeNull();
		expect(screen.queryByText("归档时间未知")).toBeNull();
		expect(screen.getByText("3天前更新")).toBeTruthy();
		view.rerender(<SessionSidebar {...props} archivedSessions={[{ ...archived, modified: new Date(NOW - 60_000).toISOString() }]} />);
		expect(screen.queryByText("已归档 3天")).toBeNull();
		expect(screen.queryByText("刚刚更新")).toBeNull();
	});

	it("orders archived sessions by most recently archived first regardless of modified timestamp or Windows casing", () => {
		const olderModNewerArchive = item("d:/sessions/newer-archive.jsonl", "archived 2d ago", NOW - 10 * DAY);
		const newerModOlderArchive = item("d:/sessions/older-archive.jsonl", "archived 5d ago", NOW - 1 * DAY);
		const rearchived = item("d:/sessions/rearchived.jsonl", "rearchived now", NOW - 30 * DAY);
		const view = render(
			<SessionSidebar
				{...shared()}
				sessions={[]}
				// 刻意按 modified 倒序传入，模拟接口原始顺序
				archivedSessions={[newerModOlderArchive, olderModNewerArchive, rearchived]}
				archivedPaths={[newerModOlderArchive.path, olderModNewerArchive.path, rearchived.path]}
				archivedAt={{
					"D:\\Sessions\\OLDER-ARCHIVE.JSONL": NOW - 5 * DAY,
					"D:\\Sessions\\NEWER-ARCHIVE.JSONL": NOW - 2 * DAY,
					"D:\\Sessions\\REARCHIVED.JSONL": NOW - 10_000,
				}}
			/>,
		);
		openArchive();
		const titles = screen.getAllByText(/archived/i).map((el) => el.textContent);
		expect(titles).toEqual(["rearchived now", "archived 2d ago", "archived 5d ago"]);

		view.rerender(
			<SessionSidebar
				{...shared()}
				sessions={[]}
				archivedSessions={[newerModOlderArchive, olderModNewerArchive, rearchived]}
				archivedPaths={[olderModNewerArchive.path, rearchived.path, newerModOlderArchive.path]}
			/>,
		);
		// Missing archivedAt falls back cleanly to reverse insertion order (last archived first).
		const fallbackTitles = screen.getAllByText(/archived/i).map((el) => el.textContent);
		expect(fallbackTitles).toEqual(["archived 5d ago", "rearchived now", "archived 2d ago"]);
	});

	it("shows plain archived label without duration on search results and current archived rows", () => {
		const archived = item("/sessions/search.jsonl", "archived body match");
		const view = render(
			<SessionSidebar
				{...shared()}
				sessions={[archived]}
				archivedPaths={[archived.path]}
				archivedAt={{ [archived.path]: NOW - 4 * DAY }}
				onSearchQuery={vi.fn()}
			/>,
		);
		fireEvent.click(screen.getByTitle("搜索"));
		fireEvent.change(screen.getByPlaceholderText("搜索会话..."), { target: { value: "body match" } });
		expect(screen.getByText("archived body match")).toBeTruthy();
		expect(screen.getByText("已归档")).toBeTruthy();
		expect(screen.queryByText("已归档 4天")).toBeNull();
		expect(screen.queryByText("3天前更新")).toBeNull();

		view.rerender(
			<I18nProvider initialLang="en">
				<SessionSidebar
					{...shared()}
					sessions={[archived]}
					currentPath={archived.path}
					archivedPaths={[archived.path]}
					archivedAt={{ [archived.path]: NOW - 2 * DAY }}
				/>
			</I18nProvider>,
		);
		expect(screen.getByText("Archived")).toBeTruthy();
		expect(screen.queryByText("Archived 2d ago")).toBeNull();
		expect(screen.getByRole("button", { name: "Unarchive" })).toBeTruthy();
	});

	it("hides archive duration in English archive group while preserving update age on regular items", () => {
		const archived = item("/sessions/archive.jsonl", "archive item");
		const ordinary = item("/sessions/ordinary.jsonl", "ordinary item");
		const props = { ...shared(), sessions: [ordinary], archivedSessions: [archived], archivedPaths: [archived.path] };
		render(<I18nProvider initialLang="en"><SessionSidebar {...props} archivedAt={{ [archived.path]: NOW - 3 * DAY }} /></I18nProvider>);
		fireEvent.click(screen.getByRole("button", { name: /^Archived/ }));
		expect(screen.getByText("archive item")).toBeTruthy();
		expect(screen.queryByText("Archived 3d ago")).toBeNull();
		expect(screen.queryByText("Just archived")).toBeNull();
		expect(screen.getByText("Updated 3d ago")).toBeTruthy();
	});
});
