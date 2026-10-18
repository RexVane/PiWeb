// @vitest-environment jsdom
/**
 * Ctrl/⌘+Shift+E：轨迹详情占着最右一列时，按一下就把抽屉（项目入口）叫回来。
 * 回归：快捷键的 effect 依赖里漏了 selected，打开轨迹详情后闭包里仍是旧的 null，
 * 第一下被当成「已停在项目入口 → 收起」，要按第二下才叫回来。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AppShell } from "@/components/AppShell";
import type { TrajEntry, WebMessage } from "@/lib/types";

const model = { id: "test-model", name: "Test", provider: "test", reasoning: false, contextWindow: 1000, thinkingLevels: [] };
const messages = [
	{ role: "user", id: "u1", content: [{ type: "text", text: "读一下文件" }], timestamp: 1 },
	{ role: "assistant", id: "a1", content: [{ type: "toolCall", id: "t1", name: "read", arguments: { path: "src/a.ts" } }], stopReason: "toolUse", timestamp: 2 },
] as unknown as WebMessage[];
const trajectory = [{ seq: 1, kind: "tool", ts: 2, title: "read", toolName: "read", toolCallId: "t1", detail: "TRAJ-DETAIL-MARKER" }] as unknown as TrajEntry[];

const noop = () => {};
vi.mock("@/lib/theme", () => ({ syncPebrelTheme: () => {} }));
vi.mock("@/hooks/useGrowth", () => ({
	useGrowth: () => ({
		available: true, loading: false, error: null, rounds: [], selected: null, scope: "session", range: undefined,
		changes: [], changesReady: true, tree: null, filePaths: [], expanded: new Set<string>(), fresh: false,
		selectLatest: noop, select: noop, prev: noop, next: noop, setScope: noop, toggleDir: noop, revealPath: noop,
		expandAll: noop, collapseAll: noop, expandLazy: noop, refresh: noop, recordNow: noop,
	}),
}));
vi.mock("@/components/SessionSidebar", () => ({ SessionSidebar: () => null }));
vi.mock("@/components/DrawerPanel", () => ({ DrawerPanel: ({ section }: { section: string }) => <div data-testid="drawer-panel">{section}</div> }));
vi.mock("@/components/TrajectoryView", () => ({ TrajInspector: () => <div data-testid="traj-inspector" /> }));
vi.mock("@/components/ExtensionUI", () => ({
	ExtensionDialogHost: () => null,
	ExtensionNotices: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));
vi.mock("@/hooks/usePiWeb", () => ({
	usePiWeb: () => ({
		sessions: [{ path: "/session-a", cwd: "/workspace", name: "session-a" }],
		archivedSessions: [], archivedSessionPaths: [], addedWorkspaces: ["/workspace"], removedWorkspaces: [], workspaceAliases: {},
		currentPath: "/session-a", currentId: "/session-a",
		models: { models: [model], providers: [{ id: "test", name: "Test", authReady: true }] },
		state: {
			snapshot: { cwd: "/workspace", model, trajectory, messages: [], userTurns: [], queue: { steering: [], followUp: [] } },
			messages, tools: { t1: { name: "read", args: { path: "src/a.ts" }, state: "done", result: "ok" } }, growth: { rounds: [], error: null },
			extensionStatuses: {}, extensionDialogs: [], extensionNotices: [], connected: true,
		},
		getWorkspaceName: (cwd: string) => cwd, sendCommand: async () => ({ success: true }),
		newSession: async () => null, openSession: noop, closeSession: noop,
		renameWorkspace: noop, patchSessionName: noop, archiveSession: noop, unarchiveSession: noop, resync: noop,
		setGroupBy: noop, setOrderBy: noop, addWorkspaceByPicker: noop, removeWorkspace: noop, refreshModels: noop,
		setToolPreset: noop, clearError: noop, clearCompaction: noop, setError: noop,
		answerExtensionDialog: noop, dismissExtensionNotice: noop,
	}),
}));

beforeEach(() => {
	localStorage.setItem("piweb.drawerOpen", "1");
	localStorage.setItem("piweb.drawerSection", "project");
	vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ success: true, data: {} }), text: async () => "" })));
});
afterEach(() => {
	cleanup();
	localStorage.clear();
	vi.unstubAllGlobals();
});

describe("Ctrl+Shift+E with the trajectory detail open", () => {
	it("brings the project drawer back on the first press", async () => {
		render(<AppShell />);
		expect(await screen.findByTestId("drawer-panel")).toBeTruthy();
		await waitFor(() => expect(document.querySelector(".pw-turn")).toBeTruthy());
		// 连续的只读工具会折叠成一行摘要：先展开，工具行上才有「在轨迹中查看」
		const summary = document.querySelector(".pw-run [aria-expanded]") as HTMLElement | null;
		if (summary) fireEvent.click(summary);
		fireEvent.click(await screen.findByRole("button", { name: /在轨迹中查看|View in trajectory/ }));
		expect(await screen.findByTestId("traj-inspector")).toBeTruthy();

		fireEvent.keyDown(document, { key: "E", ctrlKey: true, shiftKey: true });
		await waitFor(() => expect(screen.queryByTestId("traj-inspector")).toBeNull());
		expect(screen.getByTestId("drawer-panel").textContent).toBe("project");

		// 已经停在项目入口时再按一下才收起
		fireEvent.keyDown(document, { key: "E", ctrlKey: true, shiftKey: true });
		await waitFor(() => expect(screen.queryByTestId("drawer-panel")).toBeNull());
	}, 30_000);
});
