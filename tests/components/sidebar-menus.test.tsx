// @vitest-environment jsdom
/**
 * 行菜单「再点一下『…』能关上」。
 * 回归：document 的 mousedown 先把菜单关掉，紧跟着「…」按钮的 click 又把它打开——
 * 触发按钮不在菜单的 ref 里，再点一下永远关不掉。测试照真实顺序先 mouseDown 再 click。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SessionSidebar } from "@/components/SessionSidebar";
import type { SessionListItem } from "@/hooks/usePiWeb";

afterEach(cleanup);

const session: SessionListItem = {
	path: "/sessions/a.jsonl",
	cwd: "/work/proj",
	created: "2026-10-18T01:00:00.000Z",
	modified: "2026-10-18T01:00:00.000Z",
	messageCount: 2,
	firstMessage: "hello",
	streaming: false,
};

function renderSidebar(groupBy: "workspace" | "flat", archivedSessions: SessionListItem[] = []) {
	return render(
		<SessionSidebar
			sessions={[session]}
			archivedSessions={archivedSessions}
			archivedPaths={archivedSessions.map((s) => s.path)}
			addedWorkspaces={["/work/proj"]}
			currentPath={null}
			groupBy={groupBy}
			orderBy="updated"
			setGroupBy={vi.fn()}
			setOrderBy={vi.fn()}
			collapsed={false}
			onToggleCollapse={vi.fn()}
			onOpen={vi.fn()}
			onNew={vi.fn()}
			onNewInWorkspace={vi.fn()}
			onRename={vi.fn(async () => {})}
			onOpenSettings={vi.fn()}
			onAddWorkspace={vi.fn()}
		/>,
	);
}

/** 浏览器里一次点击：先 mousedown（document 监听在这里关菜单），再 click */
function press(element: Element) {
	fireEvent.mouseDown(element);
	fireEvent.click(element);
}

describe("sidebar row menus", () => {
	it("closes the session menu when its … button is pressed again", () => {
		renderSidebar("flat");
		const trigger = screen.getByRole("button", { name: "session-actions" });
		press(trigger);
		expect(screen.getByText("重命名")).toBeTruthy();
		press(trigger);
		expect(screen.queryByText("重命名")).toBeNull();
	});

	it("closes the workspace menu when its … button is pressed again", () => {
		renderSidebar("workspace");
		const trigger = screen.getByRole("button", { name: "workspace-actions" });
		press(trigger);
		expect(screen.getByText("删除工作区")).toBeTruthy();
		press(trigger);
		expect(screen.queryByText("删除工作区")).toBeNull();
	});

	it("tells the user archived sessions are deleted 30 days after archiving", () => {
		const archived: SessionListItem = { ...session, path: "/sessions/old.jsonl", firstMessage: "old" };
		renderSidebar("flat", [archived]);
		press(screen.getByRole("button", { name: "session-actions" }));
		expect(screen.getByText("归档会话").closest("button")?.getAttribute("title")).toBe("归档满 30 天自动删除");
		fireEvent.mouseDown(document.body);

		const group = screen.getByRole("button", { name: /已归档/ });
		expect(group.getAttribute("title")).toContain("30 天");
		expect(screen.queryByText("归档满 30 天自动删除")).toBeNull();
		fireEvent.click(group);
		expect(screen.getByText("归档满 30 天自动删除")).toBeTruthy();
	});

	it("still closes a menu when pressing outside", () => {
		renderSidebar("workspace");
		press(screen.getByRole("button", { name: "workspace-actions" }));
		expect(screen.getByText("删除工作区")).toBeTruthy();
		fireEvent.mouseDown(document.body);
		expect(screen.queryByText("删除工作区")).toBeNull();
	});
});
