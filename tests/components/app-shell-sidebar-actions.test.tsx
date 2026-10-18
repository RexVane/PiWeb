// @vitest-environment jsdom
/**
 * 侧栏操作不该重载眼前的对话。
 * 回归：给冷会话改名、取消归档、删除工作区之后都调了 resync()——它重连的是当前会话的事件流、重新取快照，
 * 和这几个操作毫无关系；正在流式输出时整页对话会被重载一遍。侧栏数据本来就按服务端返回就地更新。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { AppShell } from "@/components/AppShell";

const model = { id: "test-model", name: "Test", provider: "test", reasoning: false, contextWindow: 1000, thinkingLevels: [] };
const hooks = vi.hoisted(() => ({
	resync: vi.fn(),
	sendCommand: vi.fn(async () => ({ success: true })),
	patchSessionName: vi.fn(),
	unarchiveSession: vi.fn(async () => {}),
	removeWorkspace: vi.fn(async () => {}),
	sidebarProps: null as null | Record<string, (...args: string[]) => Promise<void> | void>,
}));

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
vi.mock("@/components/SessionSidebar", () => ({
	SessionSidebar: (props: Record<string, (...args: string[]) => Promise<void> | void>) => {
		hooks.sidebarProps = props;
		return null;
	},
}));
vi.mock("@/components/DrawerPanel", () => ({ DrawerPanel: () => null }));
vi.mock("@/components/ExtensionUI", () => ({
	ExtensionDialogHost: () => null,
	ExtensionNotices: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));
vi.mock("@/hooks/usePiWeb", () => ({
	usePiWeb: () => ({
		sessions: [
			{ path: "/sessions/current.jsonl", cwd: "/workspace", name: "current" },
			{ path: "/sessions/cold.jsonl", cwd: "/other", name: "cold" },
		],
		archivedSessions: [], archivedSessionPaths: [], addedWorkspaces: ["/workspace", "/other"], removedWorkspaces: [], workspaceAliases: {},
		currentPath: "/sessions/current.jsonl", currentId: "current-id",
		models: { models: [model], providers: [{ id: "test", name: "Test", authReady: true }] },
		state: {
			snapshot: { cwd: "/workspace", model, trajectory: [], messages: [], userTurns: [], queue: { steering: [], followUp: [] } },
			messages: [], tools: {}, growth: { rounds: [], error: null },
			extensionStatuses: {}, extensionDialogs: [], extensionNotices: [], connected: true,
		},
		getWorkspaceName: (cwd: string) => cwd, sendCommand: hooks.sendCommand,
		newSession: async () => null, openSession: noop, closeSession: noop,
		renameWorkspace: noop, patchSessionName: hooks.patchSessionName, archiveSession: noop, unarchiveSession: hooks.unarchiveSession, resync: hooks.resync,
		setGroupBy: noop, setOrderBy: noop, addWorkspaceByPicker: noop, removeWorkspace: hooks.removeWorkspace, refreshModels: noop,
		setToolPreset: noop, clearError: noop, clearCompaction: noop, setError: noop,
		answerExtensionDialog: noop, dismissExtensionNotice: noop,
	}),
}));

beforeEach(() => {
	vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ success: true, data: {} }), text: async () => "" })));
});
afterEach(() => {
	cleanup();
	localStorage.clear();
	vi.unstubAllGlobals();
	vi.clearAllMocks();
	hooks.sidebarProps = null;
});

describe("sidebar actions leave the open conversation alone", () => {
	it("renames a cold session, unarchives and deletes a workspace without resyncing the current session", async () => {
		render(<AppShell />);
		await waitFor(() => expect(hooks.sidebarProps).not.toBeNull());
		hooks.resync.mockClear();

		await act(async () => { await hooks.sidebarProps!.onRename("/sessions/cold.jsonl", "新名字"); });
		expect(hooks.sendCommand).toHaveBeenCalledWith({ cmd: "rename", text: "新名字" }, expect.any(String));
		expect(hooks.patchSessionName).toHaveBeenCalledWith("/sessions/cold.jsonl", "新名字");

		await act(async () => { await hooks.sidebarProps!.onUnarchive("/sessions/old.jsonl"); });
		expect(hooks.unarchiveSession).toHaveBeenCalledWith("/sessions/old.jsonl");

		await act(async () => { await hooks.sidebarProps!.onDeleteWorkspace("/other"); });
		expect(hooks.removeWorkspace).toHaveBeenCalledWith("/other");

		expect(hooks.resync).not.toHaveBeenCalled();
	}, 30_000);

	it("renames the open session through its own connection", async () => {
		render(<AppShell />);
		await waitFor(() => expect(hooks.sidebarProps).not.toBeNull());
		await act(async () => { await hooks.sidebarProps!.onRename("/sessions/current.jsonl", "当前"); });
		expect(hooks.sendCommand).toHaveBeenCalledWith({ cmd: "rename", text: "当前" });
	}, 30_000);
});
