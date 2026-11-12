// @vitest-environment jsdom
/**
 * 行菜单「再点一下『…』能关上」。
 * 回归：document 的 mousedown 先把菜单关掉，紧跟着「…」按钮的 click 又把它打开——
 * 触发按钮不在菜单的 ref 里，再点一下永远关不掉。测试照真实顺序先 mouseDown 再 click。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { SessionSidebar } from "@/components/SessionSidebar";
import { usePiWeb, type SessionListItem } from "@/hooks/usePiWeb";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const session: SessionListItem = {
	path: "/sessions/a.jsonl",
	cwd: "/work/proj",
	created: "2026-10-18T01:00:00.000Z",
	modified: "2026-10-18T01:00:00.000Z",
	messageCount: 2,
	firstMessage: "hello",
	streaming: false,
};

function renderSidebar(
	groupBy: "workspace" | "flat",
	archivedSessions: SessionListItem[] = [],
	handlers: {
		onArchive?: (path: string) => void;
		onDelete?: (path: string) => Promise<void>;
		onPin?: (path: string) => void | Promise<void>;
		onUnpin?: (path: string) => void | Promise<void>;
		onRename?: (path: string, name: string) => Promise<void>;
	} = {},
	pinnedPaths: string[] = [],
	extraSessions: SessionListItem[] = [],
) {
	return render(
		<SessionSidebar
			{...handlers}
			sessions={[session, ...extraSessions]}
			archivedSessions={archivedSessions}
			archivedPaths={archivedSessions.map((s) => s.path)}
			pinnedPaths={pinnedPaths}
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
			onRename={handlers.onRename ?? vi.fn(async () => {})}
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
	it("does not submit a rename while an IME is composing or confirming a candidate", async () => {
		const onRename = vi.fn(async () => {});
		renderSidebar("flat", [], { onRename });
		press(screen.getByRole("button", { name: "session-actions" }));
		fireEvent.click(screen.getByRole("button", { name: "重命名" }));
		const input = screen.getByRole("textbox");
		fireEvent.change(input, { target: { value: "中文会话" } });
		fireEvent.keyDown(input, { key: "Enter", isComposing: true });
		fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
		fireEvent.compositionStart(input);
		fireEvent.keyDown(input, { key: "Enter" });
		fireEvent.keyDown(input, { key: "Escape" });
		expect(onRename).not.toHaveBeenCalled();
		expect(screen.getByRole("textbox")).toBe(input);
		fireEvent.compositionEnd(input);
		await act(async () => fireEvent.keyDown(input, { key: "Enter" }));
		expect(onRename).toHaveBeenCalledWith(session.path, "中文会话");
	});

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
		expect(screen.getByRole("button", { name: "归档会话" }).getAttribute("title")).toBe("归档会话 · 归档满 30 天自动删除");

		const group = screen.getByRole("button", { name: /已归档/ });
		expect(group.getAttribute("title")).toContain("30 天");
		expect(screen.queryByText("归档满 30 天自动删除")).toBeNull();
		fireEvent.click(group);
		expect(screen.getByText("归档满 30 天自动删除")).toBeTruthy();
	});

	it("archives from the row icon, and keeps archive out of the ⋮ menu", () => {
		const onArchive = vi.fn();
		renderSidebar("flat", [], { onArchive });
		fireEvent.click(screen.getByRole("button", { name: "归档会话" }));
		expect(onArchive).toHaveBeenCalledWith("/sessions/a.jsonl");

		press(screen.getByRole("button", { name: "session-actions" }));
		expect(screen.getByText("删除会话")).toBeTruthy();
		// 菜单里只剩重命名/导出/分支/删除，归档只在图标上
		expect(screen.queryAllByText("归档会话")).toHaveLength(0);
	});

	it("permanently deletes a session only after confirming", async () => {
		const onDelete = vi.fn(async () => {});
		renderSidebar("flat", [], { onDelete });
		press(screen.getByRole("button", { name: "session-actions" }));
		fireEvent.click(screen.getByText("删除会话"));
		expect(onDelete).not.toHaveBeenCalled();
		expect(screen.getByRole("dialog").textContent).toContain("无法恢复");

		fireEvent.click(screen.getByRole("button", { name: "取消" }));
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(onDelete).not.toHaveBeenCalled();

		press(screen.getByRole("button", { name: "session-actions" }));
		fireEvent.click(screen.getByText("删除会话"));
		const dialog = screen.getByRole("dialog");
		fireEvent.click(within(dialog).getByRole("button", { name: "删除会话" }));
		await waitFor(() => expect(onDelete).toHaveBeenCalledWith("/sessions/a.jsonl"));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	});

	it("pins and unpins a session from the row button and the menu", () => {
		const onPin = vi.fn();
		const onUnpin = vi.fn();
		// 1. 未置顶时点击行内置顶按钮
		const { rerender } = renderSidebar("flat", [], { onPin, onUnpin }, []);
		fireEvent.click(screen.getByRole("button", { name: "置顶会话" }));
		expect(onPin).toHaveBeenCalledWith("/sessions/a.jsonl");

		// 菜单里显示置顶选项
		press(screen.getByRole("button", { name: "session-actions" }));
		expect(screen.getByText("置顶会话")).toBeTruthy();
		fireEvent.mouseDown(document.body);

		// 2. 已置顶时
		rerender(
			<SessionSidebar
				sessions={[session]}
				archivedSessions={[]}
				archivedPaths={[]}
				pinnedPaths={["/sessions/a.jsonl"]}
				addedWorkspaces={["/work/proj"]}
				currentPath={null}
				groupBy="flat"
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
				onPin={onPin}
				onUnpin={onUnpin}
			/>,
		);

		// 行内置顶按钮呈现取消置顶
		const unpinBtn = screen.getByRole("button", { name: "取消置顶" });
		expect(unpinBtn.className).toContain("rounded-full");
		fireEvent.click(unpinBtn);
		expect(onUnpin).toHaveBeenCalledWith("/sessions/a.jsonl");

		// 菜单里显示取消置顶
		press(screen.getByRole("button", { name: "session-actions" }));
		expect(screen.getByText("取消置顶")).toBeTruthy();
	});

	it.each([
		["row", false], ["row", true], ["menu", false], ["menu", true],
	] as const)("handles a rejected %s pin action when pinned=%s", async (entry, pinned) => {
		const onPin = vi.fn(async () => { throw new Error("pin failed"); });
		const onUnpin = vi.fn(async () => { throw new Error("unpin failed"); });
		renderSidebar("flat", [], { onPin, onUnpin }, pinned ? [session.path] : []);
		if (entry === "menu") press(screen.getByRole("button", { name: "session-actions" }));
		const label = pinned ? "取消置顶" : "置顶会话";
		const button = entry === "menu" ? screen.getByText(label).closest("button")! : screen.getByRole("button", { name: label });
		await act(async () => fireEvent.click(button));
		expect(pinned ? onUnpin : onPin).toHaveBeenCalledExactlyOnceWith(session.path);
		expect(pinned ? onPin : onUnpin).not.toHaveBeenCalled();
		expect(screen.queryByText("重命名")).toBeNull();
	});

	it("sorts pinned sessions ahead of regular sessions", () => {
		const session2: SessionListItem = {
			path: "/sessions/b.jsonl",
			cwd: "/work/proj",
			created: "2026-10-19T01:00:00.000Z",
			modified: "2026-10-19T01:00:00.000Z", // 修改时间比 a 更晚
			messageCount: 1,
			firstMessage: "session b",
			streaming: false,
		};
		// 虽然 b 比 a 新，但 a 置顶了，所以 a 排在前面
		const { container } = renderSidebar("flat", [], {}, ["/sessions/a.jsonl"], [session2]);
		const sessionTitles = Array.from(container.querySelectorAll(".isx-menu-shift")).map((el) => el.textContent);
		const indexA = sessionTitles.indexOf("hello");
		const indexB = sessionTitles.indexOf("session b");
		expect(indexA).toBeLessThan(indexB);
	});

	it("still closes a menu when pressing outside", () => {
		renderSidebar("workspace");
		press(screen.getByRole("button", { name: "workspace-actions" }));
		expect(screen.getByText("删除工作区")).toBeTruthy();
		fireEvent.mouseDown(document.body);
		expect(screen.queryByText("删除工作区")).toBeNull();
	});
});

describe("confirmed session pin state", () => {
	it.each(["pinSession", "unpinSession"] as const)("keeps the saved state when %s fails and updates it after a successful retry", async (action) => {
		localStorage.clear();
		const initialPinned = action === "unpinSession" ? [session.path] : [];
		const confirmedPinned = action === "pinSession" ? [session.path] : [];
		const registry = { workspaces: [session.cwd], aliases: {}, archivedSessions: [], pinnedSessions: initialPinned, removedWorkspaces: [] };
		const response = (data: unknown) => new Response(JSON.stringify({ success: true, data }));
		let finish!: (value: Response) => void;
		const requests: unknown[] = [];
		vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url === "/api/workspaces" && init?.method === "POST") {
				requests.push(JSON.parse(String(init.body)));
				return new Promise<Response>((done) => { finish = done; });
			}
			return response(url === "/api/sessions" ? { sessions: [session], running: {}, workspaceRegistry: registry }
				: url === "/api/workspaces" ? registry : url === "/api/models" ? { models: [], providers: [] } : {});
		}));
		const hook = renderHook(() => usePiWeb());
		await waitFor(() => expect(hook.result.current.sessions).toHaveLength(1));
		expect(hook.result.current.pinnedSessionPaths).toEqual(initialPinned);

		let pending!: Promise<void>;
		act(() => { pending = hook.result.current[action](session.path); });
		expect(hook.result.current.pinnedSessionPaths).toEqual(initialPinned);
		await act(async () => {
			finish(new Response(JSON.stringify({ success: false, error: "pin save failed" }), { status: 503 }));
			await expect(pending).rejects.toThrow("pin save failed");
		});
		expect(hook.result.current.pinnedSessionPaths).toEqual(initialPinned);
		expect(hook.result.current.state.error).toBe("pin save failed");

		act(() => { pending = hook.result.current[action](session.path); });
		expect(hook.result.current.pinnedSessionPaths).toEqual(initialPinned);
		await act(async () => { finish(response({ pinnedSessions: confirmedPinned })); await pending; });
		expect(hook.result.current.pinnedSessionPaths).toEqual(confirmedPinned);
		expect(requests).toEqual([{ action, path: session.path }, { action, path: session.path }]);
	});
});
