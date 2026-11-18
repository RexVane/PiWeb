// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { AppShell } from "@/components/AppShell";
import { safeLocalStorage } from "@/lib/browser-storage";

const mocks = vi.hoisted(() => ({ path: "/session-a" as string | null, ready: true, fallback: true }));
const noop = () => {};
const model = { id: "test-model", name: "Test", provider: "test", reasoning: false, contextWindow: 1000, thinkingLevels: [] };
vi.mock("@/lib/theme", () => ({ syncPebrelTheme: () => {} }));
vi.mock("@/components/ChatInput", () => ({ ChatInput: () => null, EMPTY_CHAT_DRAFT: { text: "", images: [], uploads: [] } }));
vi.mock("@/components/ChatWindow", () => ({
	ChatWindow: ({ onOpenPath }: { onOpenPath: (path: string) => void }) => <>
		<button onClick={() => onOpenPath("a.txt")}>Open alpha</button>
		<button onClick={() => onOpenPath("b.txt")}>Open beta</button>
	</>,
	SessionStatsBar: () => null,
}));
vi.mock("@/components/SessionSidebar", () => ({ SessionSidebar: () => null }));
vi.mock("@/components/DrawerPanel", () => ({ DrawerPanel: ({ onOpenContent }: { onOpenContent?: (path: string, content: string) => void }) => <button onClick={() => onOpenContent?.("/skills/demo/SKILL.md", "global skill document")}>Read global skill</button> }));
vi.mock("@/components/workspace/SkillsPluginsViews", () => ({
	PluginsWorkspaceView: () => null, MarketWorkspaceView: () => null,
}));
vi.mock("@/components/ExtensionUI", () => ({ ExtensionDialogHost: () => null, ExtensionNotices: () => null, ExtensionWidgets: () => null }));
vi.mock("@/hooks/useGrowth", () => ({ useGrowth: () => ({
	available: true, loading: false, error: null, rounds: [], selected: null, scope: "session", range: null,
	changes: [], changesReady: true, tree: null, filePaths: [], expanded: new Set<string>(), fresh: new Set<string>(),
	selectLatest: noop, select: noop, prev: noop, next: noop, setScope: noop, toggleDir: noop, revealPath: noop,
	expandAll: noop, collapseAll: noop, expandLazy: noop, refresh: noop, recordNow: noop,
}) }));
vi.mock("@/hooks/usePiWeb", () => ({ usePiWeb: () => ({
	sessions: mocks.ready ? ["/session-a", "/session-b"].map((path) => ({ path, cwd: "/workspace", name: path })) : [],
	archivedSessions: [], archivedSessionPaths: [], addedWorkspaces: mocks.fallback ? ["/fallback"] : [], removedWorkspaces: [], workspaceAliases: {},
	currentPath: mocks.path, currentId: mocks.path,
	models: { models: [model], providers: [{ id: "test", name: "Test", authReady: true }] },
	state: {
		snapshot: { sessionPath: mocks.ready ? mocks.path : "/stale-session", cwd: mocks.ready ? "/workspace" : "/stale-workspace", model, trajectory: [], messages: [], userTurns: [], queue: { steering: [], followUp: [] } },
		messages: [], tools: {}, growth: { rounds: [], error: null }, extensionStatuses: {}, extensionDialogs: [], extensionNotices: [], connected: true,
	},
	getWorkspaceName: (cwd: string) => cwd, sendCommand: async () => ({ success: true }),
	newSession: async () => null, openSession: noop, closeSession: noop,
	renameWorkspace: noop, patchSessionName: noop, archiveSession: noop, unarchiveSession: noop, resync: noop,
	setGroupBy: noop, setOrderBy: noop, addWorkspaceByPicker: noop, removeWorkspace: noop, refreshModels: noop,
	clearError: noop, clearCompaction: noop, setError: noop, answerExtensionDialog: noop, dismissExtensionNotice: noop,
}) }));

beforeAll(async () => {
	// These tests cover tab lifecycle; load the real preview before starting their interaction clocks.
	await import("@/components/FileViewer");
});
beforeEach(() => {
	safeLocalStorage.clear();
	mocks.path = "/session-a"; mocks.ready = true; mocks.fallback = true;
	vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ success: true, data: { content: "current file body", binary: false, truncated: false } }) })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); safeLocalStorage.clear(); });
const open = async (name: string) => {
	await screen.findByRole("button", { name });
	// Lazy children can remount while the awaited query resolves; click the current node.
	fireEvent.click(screen.getByRole("button", { name }));
};
const tabPaths = () => [...screen.getByTestId("file-viewer").querySelectorAll(".pw-viewer-tab-main")].map((tab) => tab.getAttribute("title"));

describe("AppShell file viewer lifecycle", () => {
	it("retains each conversation's files, then clears all files when closing in that same conversation", async () => {
		const view = render(<AppShell />);
		await open("Open alpha");
		await screen.findByTestId("file-viewer");
		await open("Open beta");
		expect(tabPaths()).toEqual(["a.txt", "b.txt"]);
		mocks.path = "/session-b"; view.rerender(<AppShell />);
		expect(screen.queryByTestId("file-viewer")).toBeNull();
		await open("Open beta");
		await screen.findByTestId("file-viewer");
		expect(tabPaths()).toEqual(["b.txt"]);
		mocks.path = "/session-a"; view.rerender(<AppShell />);
		await waitFor(() => expect(tabPaths()).toEqual(["a.txt", "b.txt"]));
		fireEvent.click(screen.getByTestId("viewer-close"));
		expect(screen.queryByTestId("file-viewer")).toBeNull();
		await open("Open alpha");
		await screen.findByTestId("file-viewer");
		expect(tabPaths()).toEqual(["a.txt"]);
		fireEvent.click(screen.getByTestId("viewer-close"));
		view.unmount();
		render(<AppShell />);
		await screen.findByRole("button", { name: "Open beta" });
		expect(screen.queryByTestId("file-viewer")).toBeNull();
		await open("Open beta");
		await screen.findByTestId("file-viewer");
		expect(tabPaths()).toEqual(["b.txt"]);
	});

	it.each(["Escape", "backdrop"])("clears tabs when the viewer is closed by %s", async (action) => {
		render(<AppShell />);
		await open("Open alpha");
		await screen.findByTestId("file-viewer");
		await open("Open beta");
		if (action === "Escape") fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
		else fireEvent.mouseDown(screen.getByTestId("file-viewer").parentElement!);
		expect(screen.queryByTestId("file-viewer")).toBeNull();
		await open("Open alpha");
		await screen.findByTestId("file-viewer");
		expect(tabPaths()).toEqual(["a.txt"]);
	});

	it("closing one tab retains the other tabs", async () => {
		render(<AppShell />);
		await open("Open alpha");
		await screen.findByTestId("file-viewer");
		await open("Open beta");
		fireEvent.click(within(screen.getByTestId("file-viewer")).getByRole("button", { name: "关闭页签: b.txt" }));
		expect(tabPaths()).toEqual(["a.txt"]);
		expect(screen.getByTestId("file-viewer").querySelector('.pw-viewer-tab[data-active="true"] .pw-viewer-tab-main')?.getAttribute("title")).toBe("a.txt");
	});

	it("restores a saved conversation only when its own workspace is known", async () => {
		safeLocalStorage.setItem("piweb.fileViewer.session:/session-a", JSON.stringify({ version: 1, open: true, tabs: [{ path: "a.txt", lazy: true }], active: "a.txt" }));
		mocks.ready = false;
		const view = render(<AppShell />);
		expect(screen.queryByTestId("file-viewer")).toBeNull();
		expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes("/api/files"))).toBe(false);
		mocks.ready = true; view.rerender(<AppShell />);
		await screen.findByTestId("file-viewer");
		await waitFor(() => expect(screen.getByTestId("file-viewer").textContent).toContain("current file body"));
		expect(tabPaths()).toEqual(["a.txt"]);
		expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes("/api/files?read=1&cwd=%2Fworkspace&path=a.txt"))).toBe(true);
	});

	it("reloads restored source documents and follows their links through the original source boundary", async () => {
		const sourcePath = "/skills/demo/SKILL.md";
		const path = "/skills/demo/references/client.md";
		safeLocalStorage.setItem("piweb.fileViewer.session:/session-a", JSON.stringify({ version: 1, open: true, tabs: [{ path, sourcePath, lazy: true }], active: path }));
		const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
			const content = String(url) === "/api/prompts"
				? JSON.parse(String(init?.body)).filePath === path ? "[继续](nested/next.md) ![图示](../images/demo.png)" : "restored linked document"
				: "";
			return { ok: true, json: async () => ({ success: true, data: { content } }) };
		});
		vi.stubGlobal("fetch", fetchMock);
		render(<AppShell />);
		const image = await screen.findByRole("img", { name: "图示" });
		expect(new URL(image.getAttribute("src")!, "http://localhost").searchParams.get("sourcePath")).toBe(sourcePath);
		expect(screen.getByTestId("file-viewer").querySelector("a[download]")).toBeNull();
		await screen.findByRole("link", { name: "继续" });
		const link = screen.getByRole("link", { name: "继续" });
		expect(link.className).toBe("md-file-link");
		fireEvent.click(link);
		await waitFor(() => expect(screen.getByTestId("file-viewer").textContent).toContain("restored linked document"));
		expect(tabPaths()).toEqual([path, "/skills/demo/references/nested/next.md"]);
		const reads = fetchMock.mock.calls.filter(([url]) => String(url) === "/api/prompts").map(([, init]) => JSON.parse(String(init?.body)));
		expect(reads).toContainEqual({ action: "read", cwd: "/workspace", filePath: path, sourcePath });
		expect(reads).toContainEqual({ action: "read", cwd: "/workspace", filePath: "/skills/demo/references/nested/next.md", sourcePath });
		expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith("/api/files"))).toBe(false);
	});

	it("keeps an unavailable restored source tab and shows its error without falling back to a workspace read", async () => {
		const path = "/skills/removed/SKILL.md";
		safeLocalStorage.setItem("piweb.fileViewer.session:/session-a", JSON.stringify({ version: 1, open: true, tabs: [{ path, sourcePath: path, lazy: true }], active: path }));
		const fetchMock = vi.fn(async (url: RequestInfo | URL) => ({ ok: String(url) !== "/api/prompts", json: async () => ({ success: false, error: "source is no longer available" }) }));
		vi.stubGlobal("fetch", fetchMock);
		render(<AppShell />);
		await screen.findByText("source is no longer available");
		expect(tabPaths()).toEqual([path]);
		expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith("/api/files"))).toBe(false);
	});

	it("can still open a global skill document before any workspace or conversation exists", async () => {
		mocks.path = null; mocks.ready = false; mocks.fallback = false;
		render(<AppShell />);
		fireEvent.click(screen.getByTestId("drawer-toggle"));
		await open("Read global skill");
		await screen.findByTestId("file-viewer");
		await waitFor(() => expect(screen.getByTestId("file-viewer").textContent).toContain("global skill document"));
		expect(tabPaths()).toEqual(["/skills/demo/SKILL.md"]);
	});
});
