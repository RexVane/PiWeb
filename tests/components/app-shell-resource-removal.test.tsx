// @vitest-environment jsdom
import { useCallback, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AppShell } from "@/components/AppShell";
import { RESOURCE_CHANGE_EVENT, useResourceRegistry, type ResourceRegistry } from "@/hooks/useResourceRegistry";
import type { ExtensionDialog } from "@/hooks/usePiWeb";
import { RESOURCE_FRAME_CHANNEL, type WebResourceView } from "@/lib/resources/protocol";

const mocks = vi.hoisted(() => ({
	sendCommand: vi.fn(), openSession: vi.fn(), answer: vi.fn(), dialogs: [] as ExtensionDialog[],
	resolveDialog: null as null | ((id: string) => void),
}));
const noop = () => {};
const model = { id: "test-model", name: "Test", provider: "test", reasoning: false, contextWindow: 1000, thinkingLevels: [] };
vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("@/lib/theme", () => ({ syncPebrelTheme: () => {} }));
vi.mock("@/hooks/useGrowth", () => ({ useGrowth: () => ({ rounds: [], select: noop, selectLatest: noop }) }));
vi.mock("@/components/ChatWindow", () => ({ ChatWindow: () => null, SessionStatsBar: () => null }));
vi.mock("@/components/SessionSidebar", () => ({ SessionSidebar: (props: any) => <>
	<button onClick={() => props.onOpen("/session-a")}>Open A</button>
	<button onClick={() => props.onOpen("/session-b")}>Open B</button>
</> }));
vi.mock("@/hooks/usePiWeb", () => ({ usePiWeb: () => {
	const [currentPath, setCurrentPath] = useState<string | null>("/session-a");
	const [dialogs, setDialogs] = useState(mocks.dialogs);
	mocks.resolveDialog = id => setDialogs(current => current.filter(dialog => dialog.id !== id));
	const openSession = useCallback((path: string) => { mocks.openSession(path); setCurrentPath(path); }, []);
	const answerExtensionDialog = useCallback((id: string, response: unknown) => {
		mocks.answer(id, response); setDialogs(current => current.filter(dialog => dialog.id !== id));
	}, []);
	return {
		sessions: ["/session-a", "/session-b"].map(path => ({ path, cwd: "/workspace", name: path })),
		archivedSessions: [], archivedSessionPaths: [], addedWorkspaces: ["/workspace"], removedWorkspaces: [], workspaceAliases: {},
		currentPath, currentId: currentPath, models: { models: [model], providers: [{ id: "test", name: "Test", authReady: true }] },
		state: { snapshot: { sessionPath: currentPath, isStreaming: false, cwd: "/workspace", model, trajectory: [], messages: [], userTurns: [], queue: { steering: [], followUp: [] } },
			messages: [], tools: {}, growth: { rounds: [], error: null }, extensionStatuses: {}, extensionWidgets: {}, extensionDialogs: dialogs, extensionNotices: [], connected: true },
		getWorkspaceName: (cwd: string) => cwd, sendCommand: mocks.sendCommand, openSession, closeSession: () => setCurrentPath(null),
		newSession: async () => null, renameWorkspace: noop, patchSessionName: noop, archiveSession: noop, unarchiveSession: noop, resync: noop,
		setGroupBy: noop, setOrderBy: noop, addWorkspaceByPicker: noop, removeWorkspace: noop, refreshModels: noop,
		clearError: noop, clearCompaction: noop, setError: noop, answerExtensionDialog, dismissExtensionNotice: noop,
	};
} }));

const targets = ["sample-one", "@example/sample-two", "@example/sample-three"];
const member = (id: string) => ({ id, name: id, source: `local:${id}`, scope: "project" as const, enabled: true, extensionPaths: ["index.ts"] });
const progress: WebResourceView = { id: "project:sample-two:progress", resourceId: targets[1], scope: "project", title: "Sample progress", placement: "aboveEditor", autoMount: true, methods: [], capabilities: ["sessions.open"], url: "/api/resources/views/sample-two/assets/progress.html" };
const dashboard: WebResourceView = { ...progress, id: "project:sample-two:dashboard", title: "Sample dashboard", placement: "dialog", autoMount: false };
const status: WebResourceView = { ...progress, id: "project:other:status", resourceId: "other-extension", title: "Other extension status", placement: "belowEditor", url: "/api/resources/views/other/assets/status.html" };
const question: WebResourceView = { ...status, id: "project:other:question", title: "Other extension question", autoMount: false, methods: ["select"] };
const allViews: WebResourceView[] = [progress, dashboard, status, question,
	{ ...dashboard, id: "project:sample-one:dialog", resourceId: targets[0], title: "Sample one dialog" },
	{ ...dashboard, id: "project:sample-three:dialog", resourceId: targets[2], title: "Sample three dialog" },
];
function registry(mode?: "disabled" | "uninstalled"): ResourceRegistry {
	return {
		packages: mode === "uninstalled" ? [member(status.resourceId)] : [...targets.map(id => ({ ...member(id), enabled: mode !== "disabled" })), member(status.resourceId)],
		views: mode ? [status, question] : allViews,
		preferences: { renderers: { select: question.id }, catalogUrls: [] }, hosts: [],
	};
}
const response = (data: unknown) => ({ ok: true, json: async () => ({ success: true, data }) });
const textarea = () => screen.getByPlaceholderText("给 pi 发消息…") as HTMLTextAreaElement;
function CatalogProbe() {
	const catalog = useResourceRegistry("/workspace");
	return <output data-testid="active-packages">{catalog.packages.filter(item => item.enabled).map(item => item.id).join("|")}</output>;
}
function ready(frame: HTMLIFrameElement) {
	const source = frame.contentWindow!;
	const post = vi.spyOn(source, "postMessage").mockImplementation(() => {});
	fireEvent(window, new MessageEvent("message", { source, data: { channel: RESOURCE_FRAME_CHANNEL, type: "ready" } }));
	const token = (post.mock.calls.find(([message]) => (message as { type?: string }).type === "context")![0] as { token: string }).token;
	return { source, post, token };
}
beforeEach(() => {
	localStorage.clear(); sessionStorage.clear(); mocks.dialogs = [];
	mocks.sendCommand.mockReset().mockResolvedValue({ success: true }); mocks.openSession.mockReset(); mocks.answer.mockReset();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("business resource removal leaves PiWeb usable", () => {
	it.each(["disabled", "uninstalled"] as const)("revokes %s packages, aborts their old frame actions and preserves input, drafts and another extension", async mode => {
		let catalog = registry(); let actionSignal: AbortSignal | undefined; let resolveAction!: (value: unknown) => void;
		const action = new Promise(resolve => { resolveAction = resolve; });
		vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
			if (init?.method === "POST") { actionSignal = init.signal as AbortSignal; return action; }
			return Promise.resolve(response(String(input).startsWith("/api/resources?") ? catalog : { skills: [], promptTemplates: [], extensionCommands: [], modelThinkingLevels: {} }));
		}));
		render(<><AppShell /><CatalogProbe /></>);
		const removedFrame = await screen.findByTitle("Sample progress") as HTMLIFrameElement;
		const keptFrame = screen.getByTitle("Other extension status");
		for (const id of targets) expect(screen.getByTestId("active-packages").textContent).toContain(id);
		expect(screen.queryByTitle("Sample one dialog")).toBeNull(); expect(screen.queryByTitle("Sample three dialog")).toBeNull();
		fireEvent.change(textarea(), { target: { value: "Draft A survives removal" } });
		const old = ready(removedFrame);
		fireEvent(window, new MessageEvent("message", { source: old.source, data: { channel: RESOURCE_FRAME_CHANNEL, type: "host", token: old.token, id: "late-navigation", name: "sessions.open", args: { sessionPath: "/removed-session" } } }));
		await waitFor(() => expect(actionSignal).toBeDefined());
		catalog = registry(mode); fireEvent(window, new Event(RESOURCE_CHANGE_EVENT));
		await waitFor(() => expect(screen.queryByTitle("Sample progress")).toBeNull());
		expect(actionSignal!.aborted).toBe(true); expect(screen.getByTitle("Other extension status")).toBe(keptFrame);
		for (const id of targets) expect(screen.getByTestId("active-packages").textContent).not.toContain(id);
		expect(screen.getByTestId("active-packages").textContent).toBe(status.resourceId);
		await act(async () => resolveAction(response({ type: "sessions.open", sessionPath: "/removed-session" })));
		fireEvent(window, new MessageEvent("message", { source: old.source, data: { channel: RESOURCE_FRAME_CHANNEL, type: "answer", token: old.token, value: "stale" } }));
		expect(mocks.openSession).not.toHaveBeenCalled(); expect(mocks.answer).not.toHaveBeenCalled();
		expect(old.post.mock.calls.some(([message]) => (message as { id?: string }).id === "late-navigation")).toBe(false);
		expect(textarea().value).toBe("Draft A survives removal"); expect(textarea().disabled).toBe(false);
		fireEvent.click(screen.getByRole("button", { name: "Open B" }));
		fireEvent.change(textarea(), { target: { value: "Draft B survives switching" } });
		fireEvent.click(screen.getByRole("button", { name: "Open A" }));
		expect(textarea().value).toBe("Draft A survives removal");
		fireEvent.keyDown(textarea(), { key: "Enter" });
		await waitFor(() => expect(mocks.sendCommand).toHaveBeenCalledWith(expect.objectContaining({ cmd: "prompt", text: "Draft A survives removal" })));
		await waitFor(() => expect(textarea().value).toBe(""));
		fireEvent.click(screen.getByRole("button", { name: "Open B" }));
		expect(textarea().value).toBe("Draft B survives switching"); expect(textarea().disabled).toBe(false);
	});

	it("handles backend cancellation of a removed custom dialog while another extension can still ask a native question", async () => {
		let catalog = registry();
		mocks.dialogs = [
			{ id: "removed-dashboard", method: "resource", title: "Removed sample dashboard", resourceView: dashboard, resourceData: { itemId: "sample-item" }, ts: 1 },
			{ id: "kept-question", method: "select", title: "Other extension asks", options: ["Keep working", "Stop"], ts: 2 },
		];
		vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => Promise.resolve(response(String(input).startsWith("/api/resources?") ? catalog : { skills: [], promptTemplates: [], extensionCommands: [], modelThinkingLevels: {} }))));
		render(<AppShell />);
		await screen.findByTitle("Sample dashboard");
		const keptFrame = await screen.findByTitle("Other extension question");
		catalog = registry("uninstalled"); fireEvent(window, new Event(RESOURCE_CHANGE_EVENT));
		await waitFor(() => expect(screen.queryByTitle("Sample dashboard")).toBeNull());
		// The server reconciles missing resource views and publishes extension_ui_resolved.
		act(() => mocks.resolveDialog!("removed-dashboard"));
		await waitFor(() => expect(screen.queryByRole("dialog", { name: "Removed sample dashboard" })).toBeNull());
		expect(mocks.answer).not.toHaveBeenCalled();
		expect(screen.getByTitle("Other extension question")).toBe(keptFrame);
		expect(mocks.answer.mock.calls.some(([id]) => id === "kept-question")).toBe(false);
		// Revoking the other renderer preserves its native question rather than answering it.
		catalog = { ...catalog, views: [status], preferences: { ...catalog.preferences, renderers: {} } }; fireEvent(window, new Event(RESOURCE_CHANGE_EVENT));
		const option = await screen.findByRole("option", { name: "Keep working" });
		fireEvent.click(option); expect(mocks.answer).toHaveBeenCalledWith("kept-question", { value: "Keep working" });
		fireEvent.change(textarea(), { target: { value: "Normal input still sends" } }); fireEvent.keyDown(textarea(), { key: "Enter" });
		await waitFor(() => expect(mocks.sendCommand).toHaveBeenCalledWith(expect.objectContaining({ cmd: "prompt", text: "Normal input still sends" })));
	});
});
