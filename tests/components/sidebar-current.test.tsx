// @vitest-environment jsdom
/**
 * 侧栏标出「当前」工作区与会话时按路径语义比，不按字符串比。
 * 回归：工作区来自注册表（path.resolve 过），会话头里的 cwd 原样记录；Windows 上盘符大小写、分隔符、尾斜杠不同时，
 * 当前工作区不高亮、所在分组不自动展开、当前会话行也不标选中。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { SessionSidebar } from "@/components/SessionSidebar";
import type { SessionListItem } from "@/hooks/usePiWeb";

afterEach(() => {
	cleanup();
	sessionStorage.clear();
});

const session: SessionListItem = {
	path: "d:/pi/sessions/a.jsonl",
	cwd: "d:/work/proj/",
	created: "2026-10-18T01:00:00.000Z",
	modified: "2026-10-18T01:00:00.000Z",
	messageCount: 2,
	firstMessage: "hello",
	streaming: false,
};

describe("current workspace and session in the sidebar", () => {
	it("matches the current session and workspace across drive-letter case, separators and trailing slashes", async () => {
		render(
			<SessionSidebar
				sessions={[session]}
				addedWorkspaces={["D:\\Work\\Proj"]}
				currentPath={"D:\\pi\\sessions\\a.jsonl"}
				groupBy="workspace"
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
		expect((screen.getByText("Proj") as HTMLElement).style.fontWeight).toBe("500");
		// 当前会话所在分组自动展开，会话行标选中
		const row = await waitFor(() => screen.getByText("hello").closest("[data-active]"));
		expect(row?.getAttribute("data-active")).toBe("true");
	});
});
