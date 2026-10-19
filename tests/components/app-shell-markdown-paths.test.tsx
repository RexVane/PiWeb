// @vitest-environment jsdom
/**
 * 接线级回归：正文行内代码里的路径点开的是 AppShell 的**页内文件查看器**
 * （viewer.open → role=dialog 的 FileViewer），不是本机编辑器。
 *
 * 为什么要有这条：ChatWindow 自己的用例只能证明它调了 onOpenPath，
 * 证明不了 AppShell 把这个 prop 接到了 viewer.open 上（接错成 openInEditor 也照样绿）。
 * 这里用真实的 ChatWindow + FileViewer 走一遍点击。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AppShell } from "@/components/AppShell";
import type { WebMessage } from "@/lib/types";

const FILE_PATH = "src/components/SettingsPanel.tsx";
const MARKDOWN_READY_TIMEOUT_MS = 20_000;

const model = { id: "test-model", name: "Test", provider: "test", reasoning: false, contextWindow: 1000, thinkingLevels: [] };
/** 一条带行内路径的模型回复 */
const answer = {
	role: "assistant",
	id: "a1",
	content: [{ type: "text", text: `入口在 \`${FILE_PATH}\` 里。` }],
	stopReason: "stop",
	timestamp: 1,
} as unknown as WebMessage;

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
			snapshot: { cwd: "/workspace", model, trajectory: [], messages: [], userTurns: [], queue: { steering: [], followUp: [] } },
			messages: [answer], tools: {}, growth: { rounds: [], error: null },
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

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe("正文里的文件路径点击（AppShell 接线）", () => {
	it("点开页内文件查看器，而不是本机编辑器", async () => {
		// 本机编辑器那条路是 POST /api/files {action:"open"}：把它做成会失败的探针，
		// 一旦有人把 onOpenPath 接回 openInEditor，这里就能看见。
		const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
			const body = typeof init?.body === "string" ? init.body : "";
			if (url.includes("/api/files") && body.includes('"open"')) throw new Error("不该走本机编辑器");
			const data = url.includes("/api/files") && url.includes("read=1")
				? { content: "// FILE_VIEWER_READY", binary: false, truncated: false } : {};
			return { ok: true, status: 200, json: async () => ({ success: true, data }), text: async () => "" } as unknown as Response;
		});
		vi.stubGlobal("fetch", fetchMock);

		render(<AppShell />);
		await waitFor(() => expect(document.querySelector("button.md-file-path")).toBeTruthy(), { timeout: MARKDOWN_READY_TIMEOUT_MS });
		fireEvent.click(document.querySelector("button.md-file-path") as HTMLElement);

		// 查看器出现，并且落在被点的那条路径上
		const viewer = await screen.findByRole("dialog");
		await waitFor(() => expect(viewer.textContent).toContain(FILE_PATH));
		await waitFor(() => expect(viewer.textContent).toContain("// FILE_VIEWER_READY"));
		expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining("/api/files"), expect.objectContaining({ body: expect.stringContaining('"open"') }));
	}, 30_000);
});
