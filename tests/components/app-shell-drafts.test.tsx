// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { AppShell } from "@/components/AppShell";

const mocks = vi.hoisted(() => ({ sendCommand: vi.fn(), newSession: vi.fn() }));
const model = { id: "test-model", name: "Test", provider: "test", reasoning: false, contextWindow: 1000, thinkingLevels: [] };
const noop = () => {};
vi.mock("next/dynamic", () => ({ default: () => (props: any) => props.onReference ? <button onClick={() => props.onReference("@ref.txt")}>Reference file</button> : null }));
vi.mock("@/lib/theme", () => ({ syncPebrelTheme: () => {} }));
vi.mock("@/hooks/useGrowth", () => ({ useGrowth: () => ({}) }));
vi.mock("@/components/ChatWindow", () => ({ ChatWindow: () => null, SessionStatsBar: () => null }));
vi.mock("@/components/ExtensionUI", () => ({ ExtensionDialogHost: () => null, ExtensionNotices: () => null }));
vi.mock("@/components/SessionSidebar", () => ({ SessionSidebar: (props: any) => <>
	<button onClick={() => props.onOpen("/session-a")}>Open A</button>
	<button onClick={() => props.onOpen("/session-b")}>Open B</button>
	<button onClick={() => props.onOpen("/created")}>Open created</button>
	<button onClick={() => props.onNewInWorkspace("/workspace")}>New hero</button>
</> }));
vi.mock("@/hooks/usePiWeb", () => ({ usePiWeb: () => {
	const [currentPath, setCurrentPath] = useState<string | null>("/session-a");
	return {
		sessions: ["/session-a", "/session-b", "/created"].map((path) => ({ path, cwd: "/workspace", name: path })),
		archivedSessions: [], archivedSessionPaths: [], addedWorkspaces: ["/workspace"], removedWorkspaces: [], workspaceAliases: {},
		currentPath, currentId: currentPath, models: { models: [model], providers: [{ id: "test", name: "Test", authReady: true }] },
		state: { snapshot: currentPath ? { cwd: "/workspace", model, trajectory: [], messages: [], userTurns: [], queue: { steering: [], followUp: [] } } : null,
			messages: [], tools: {}, growth: { steps: [], pending: false }, extensionStatuses: {}, extensionDialogs: [], extensionNotices: [], connected: true },
		getWorkspaceName: (cwd: string) => cwd, sendCommand: mocks.sendCommand,
		newSession: async (...args: unknown[]) => { const path = await mocks.newSession(...args); if (path) setCurrentPath(path); return path; },
		openSession: setCurrentPath, closeSession: () => setCurrentPath(null),
		renameWorkspace: noop, patchSessionName: noop, archiveSession: noop, unarchiveSession: noop, resync: noop,
		setGroupBy: noop, setOrderBy: noop, addWorkspaceByPicker: noop, removeWorkspace: noop, refreshModels: noop,
		setToolPreset: noop, clearError: noop, clearCompaction: noop, setError: noop, answerExtensionDialog: noop, dismissExtensionNotice: noop,
	};
} }));
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((yes) => { resolve = yes; });
	return { promise, resolve };
}
const response = (data: unknown) => ({ ok: true, json: async () => ({ success: true, data }) });
const textarea = () => screen.getByRole("textbox") as HTMLTextAreaElement;
const go = (name: string) => fireEvent.click(screen.getByRole("button", { name }));
// 轨迹页签已移除：用「切到别的会话再切回来」制造同样的重挂载（草稿与待接收状态由父层持有）
const remount = (returnTo = "Open A") => { go("Open B"); go(returnTo); };
beforeEach(() => { localStorage.clear(); mocks.sendCommand.mockReset().mockResolvedValue({ success: true }); mocks.newSession.mockReset().mockResolvedValue("/created"); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("AppShell session-owned composer drafts", () => {
	it("consumes file references directly into the target draft without remount/session replay", async () => {
		render(<AppShell />);
		fireEvent.click(screen.getByTestId("project-toggle"));
		fireEvent.change(textarea(), { target: { value: "draft A" } });
		textarea().setSelectionRange(7, 7);
		go("Reference file");
		expect(textarea().value).toBe("draft A @ref.txt");
		remount();
		expect(textarea().value).toBe("draft A @ref.txt");
		go("Open B");
		expect(textarea().value).toBe("");
		go("Open A");
		fireEvent.keyDown(textarea(), { key: "Enter" });
		await waitFor(() => expect(textarea().value).toBe(""));
		remount();
		expect(textarea().value).toBe("");
		go("New hero");
		go("Reference file");
		expect(textarea().value).toBe("@ref.txt");
		fireEvent.keyDown(textarea(), { key: "Enter" });
		await waitFor(() => expect(textarea().value).toBe(""));
		remount();
		expect(textarea().value).toBe("");
	});
	it("targets a late upload to A, preserving B and never reviving a removed or sent file on remount", async () => {
		const upload = deferred<ReturnType<typeof response>>();
		vi.stubGlobal("fetch", vi.fn(() => upload.promise));
		render(<AppShell />);
		fireEvent.change(textarea(), { target: { value: "draft A" } });
		fireEvent.paste(textarea(), { clipboardData: { files: [new File(["abc"], "a.txt", { type: "text/plain" })] } });
		go("Open B");
		fireEvent.change(textarea(), { target: { value: "draft B" } });
		await act(async () => upload.resolve(response({ name: "a.txt", path: "/upload/a.txt", size: 3 })));
		expect(textarea().value).toBe("draft B");
		expect(screen.queryByText("a.txt")).toBeNull();
		go("Open A");
		expect(textarea().value).toBe("draft A");
		fireEvent.click(screen.getByRole("button", { name: "remove" }));
		remount();
		expect(screen.queryByText("a.txt")).toBeNull();
		fireEvent.paste(textarea(), { clipboardData: { files: [new File(["abc"], "a.txt", { type: "text/plain" })] } });
		await screen.findByText("a.txt");
		await waitFor(() => expect((screen.getByTitle("发送") as HTMLButtonElement).disabled).toBe(false));
		fireEvent.keyDown(textarea(), { key: "Enter" });
		await waitFor(() => expect(textarea().value).toBe(""));
		remount();
		expect(screen.queryByText("a.txt")).toBeNull();
		expect(textarea().value).toBe("");
		go("Open B");
		expect(textarea().value).toBe("draft B");
	});

	it.each([true, false])("migrates Hero draft and pending acceptance to the created session (success=%s)", async (success) => {
		const accepted = deferred<{ success: boolean; error?: string }>();
		mocks.sendCommand.mockImplementation((command: any) => command.cmd === "prompt" ? accepted.promise : Promise.resolve({ success: true }));
		render(<AppShell />);
		go("New hero");
		fireEvent.change(textarea(), { target: { value: "hero prompt" } });
		fireEvent.keyDown(textarea(), { key: "Enter" });
		await waitFor(() => expect(mocks.sendCommand).toHaveBeenCalledWith(expect.objectContaining({ cmd: "prompt", text: "hero prompt" }), expect.any(String)));
		expect(textarea().value).toBe("hero prompt");
		expect(textarea().disabled).toBe(true);
		// 轨迹页签移除后没有「原地重挂载」入口：切走再进 Hero 是一份新草稿，
		// 待接收状态属于已创建的会话（下方断言验证它没有丢）。
		remount("New hero");
		expect(textarea().disabled).toBe(false);
		go("Open B");
		fireEvent.change(textarea(), { target: { value: "unrelated B" } });
		await act(async () => accepted.resolve({ success, error: success ? undefined : "rejected" }));
		expect(textarea().value).toBe("unrelated B");
		go("Open created");
		expect(textarea().value).toBe(success ? "" : "hero prompt");
		expect(textarea().disabled).toBe(false);
		remount("Open created");
		expect(textarea().value).toBe(success ? "" : "hero prompt");
		go("New hero");
		expect(textarea().value).toBe("");
	});
});
