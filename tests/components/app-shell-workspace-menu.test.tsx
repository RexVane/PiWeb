// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { AppShell } from "@/components/AppShell";

const mocks = vi.hoisted(() => ({
	workspaces: Array.from({ length: 80 }, (_, i) => `/projects/workspace-${i}`),
	addWorkspace: vi.fn<() => Promise<string | null>>(),
}));
const noop = () => {};
vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("@/lib/theme", () => ({ syncPebrelTheme: () => {} }));
vi.mock("@/hooks/useGrowth", () => ({ useGrowth: () => ({ rounds: [], select: noop, selectLatest: noop }) }));
vi.mock("@/components/SessionSidebar", () => ({ SessionSidebar: () => null }));
vi.mock("@/components/ChatWindow", () => ({ ChatWindow: () => null, SessionStatsBar: () => null }));
vi.mock("@/components/ExtensionUI", () => ({ ExtensionDialogHost: () => null, ExtensionNotices: () => null }));
vi.mock("@/components/ChatInput", () => ({ EMPTY_CHAT_DRAFT: { text: "", images: [], files: [], references: [] }, ChatInput: () => <textarea /> }));
vi.mock("@/hooks/usePiWeb", () => ({ usePiWeb: () => ({
	sessions: [], archivedSessions: [], archivedSessionPaths: [], addedWorkspaces: mocks.workspaces,
	removedWorkspaces: [], workspaceAliases: {}, currentPath: null, currentId: null,
	models: { models: [], providers: [] },
	state: { snapshot: null, messages: [], tools: {}, growth: { rounds: [], error: null }, extensionStatuses: {}, extensionDialogs: [], extensionNotices: [], connected: true },
	getWorkspaceName: (cwd: string) => cwd.split("/").pop(), addWorkspaceByPicker: mocks.addWorkspace,
	sendCommand: noop, newSession: noop, openSession: noop, closeSession: noop, renameWorkspace: noop,
	patchSessionName: noop, archiveSession: noop, unarchiveSession: noop, resync: noop, setGroupBy: noop,
	setOrderBy: noop, removeWorkspace: noop, refreshModels: noop, setToolPreset: noop, clearError: noop,
	clearCompaction: noop, setError: noop, answerExtensionDialog: noop, dismissExtensionNotice: noop,
}) }));

let triggerTop: number;
let heroTop: number;
let resizeLayout: ResizeObserverCallback;
const rect = (top: number, height: number): DOMRect => ({ top, bottom: top + height, left: 0, right: 224, width: 224, height, x: 0, y: top, toJSON: () => ({}) });
const trigger = () => document.querySelector<HTMLButtonElement>(".hero-chip")!;
const open = () => fireEvent.click(trigger());
const menu = () => screen.getByTestId("workspace-menu");
const list = () => screen.getByTestId("workspace-menu-list");

beforeEach(() => {
	localStorage.clear();
	triggerTop = 450;
	heroTop = 40;
	mocks.workspaces = Array.from({ length: 80 }, (_, i) => `/projects/workspace-${i}`);
	mocks.addWorkspace.mockReset().mockResolvedValue(null);
	vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ success: true, data: { modelThinkingLevels: {}, skills: [], promptTemplates: [], extensionCommands: [] } }) })));
	vi.stubGlobal("ResizeObserver", class {
		constructor(callback: ResizeObserverCallback) { resizeLayout = callback; }
		observe() {}
		disconnect() {}
	});
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
		return this.classList.contains("hero-chip") ? rect(triggerTop, 30) : rect(heroTop, 800);
	});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("Hero workspace menu stays within its visible area", () => {
	it("caps a long list and keeps the add action outside the scroll area", () => {
		render(<AppShell />);
		open();
		expect(menu().style.maxHeight).toBe("340px");
		// 窄屏的悬浮侧栏按钮是 z-70，菜单必须在它上面、对话框遮罩下面。
		expect(menu().classList.contains("z-[75]")).toBe(true);
		expect(list().classList.contains("overflow-y-auto")).toBe(true);
		expect(list().classList.contains("overflow-x-hidden")).toBe(true);
		expect(list().classList.contains("overscroll-contain")).toBe(true);
		expect(within(list()).getAllByRole("button")).toHaveLength(80);
		expect(list().contains(screen.getByRole("button", { name: "添加工作区" }))).toBe(false);
		expect(trigger().getAttribute("aria-expanded")).toBe("true");
	});

	it("shrinks with the available space on window and composer layout changes", () => {
		render(<AppShell />);
		open();
		triggerTop = 180;
		fireEvent(window, new Event("resize"));
		expect(menu().style.maxHeight).toBe("126px");
		triggerTop = 150;
		act(() => resizeLayout([], {} as ResizeObserver));
		expect(menu().style.maxHeight).toBe("96px");
	});

	it("scrolls only the list to the selected workspace when reopened", () => {
		vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) { return this.dataset.testid === "workspace-menu-list" ? 200 : 0; });
		vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(function (this: HTMLElement) { return this.getAttribute("aria-current") === "true" ? 2370 : 0; });
		vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(30);
		const scrollPage = vi.spyOn(Element.prototype, "scrollIntoView");
		render(<AppShell />);
		open();
		fireEvent.click(within(list()).getByRole("button", { name: "workspace-79" }));
		expect(screen.queryByTestId("workspace-menu")).toBeNull();
		expect(trigger().textContent).toContain("workspace-79");
		open();
		expect(list().scrollTop).toBe(2285);
		expect(scrollPage).not.toHaveBeenCalled();
		expect(within(list()).getByRole("button", { name: "workspace-79" }).title).toBe("/projects/workspace-79");
	});

	it("still supports adding a workspace and closes on Escape or an outside click", async () => {
		mocks.addWorkspace.mockResolvedValue("/projects/new-workspace");
		render(<AppShell />);
		open();
		fireEvent.click(screen.getByRole("button", { name: "添加工作区" }));
		await waitFor(() => expect(trigger().textContent).toContain("new-workspace"));
		expect(screen.queryByTestId("workspace-menu")).toBeNull();
		open();
		fireEvent.keyDown(document, { key: "Escape" });
		expect(screen.queryByTestId("workspace-menu")).toBeNull();
		expect(document.activeElement).toBe(trigger());
		open();
		fireEvent.mouseDown(document.body);
		expect(screen.queryByTestId("workspace-menu")).toBeNull();
	});

	it("keeps the add action available with no registered workspaces", () => {
		mocks.workspaces = [];
		render(<AppShell />);
		open();
		expect(within(list()).queryAllByRole("button")).toHaveLength(0);
		expect(screen.getByRole("button", { name: "添加工作区" })).toBeTruthy();
	});
});
