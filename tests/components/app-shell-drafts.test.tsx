// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { AppShell } from "@/components/AppShell";
import { writeRememberedHeroModel } from "@/lib/hero-model-memory";

const mocks = vi.hoisted(() => ({ sendCommand: vi.fn(), newSession: vi.fn() }));
const model = { id: "test-model", name: "Test", provider: "test", reasoning: false, contextWindow: 1000, thinkingLevels: [] };
const noop = () => {};
vi.mock("next/dynamic", () => ({ default: () => (props: any) => props.onReference ? <button onClick={() => props.onReference("@ref.txt")}>Reference file</button> : null }));
vi.mock("@/lib/theme", () => ({ syncPebrelTheme: () => {} }));
vi.mock("@/hooks/useGrowth", () => ({ useGrowth: () => ({ rounds: [], select: () => {}, selectLatest: () => {} }) }));
vi.mock("@/components/ChatWindow", () => ({ ChatWindow: () => null, SessionStatsBar: () => null }));
vi.mock("@/components/ExtensionUI", () => ({ ExtensionDialogHost: () => null, ExtensionNotices: () => null }));
vi.mock("@/components/SessionSidebar", () => ({ SessionSidebar: (props: any) => <>
	<button onClick={() => props.onOpen("/session-a")}>Open A</button>
	<button onClick={() => props.onOpen("/session-b")}>Open B</button>
	<button onClick={() => props.onOpen("/created")}>Open created</button>
	<button onClick={() => props.onNewInWorkspace("/workspace")}>New hero</button>
	<button onClick={() => props.onNewInWorkspace("/other")}>New other hero</button>
</> }));
vi.mock("@/hooks/usePiWeb", () => ({ usePiWeb: () => {
	const [currentPath, setCurrentPath] = useState<string | null>("/session-a");
	return {
		sessions: ["/session-a", "/session-b", "/created"].map((path) => ({ path, cwd: "/workspace", name: path })),
		archivedSessions: [], archivedSessionPaths: [], addedWorkspaces: ["/workspace"], removedWorkspaces: [], workspaceAliases: {},
		currentPath, currentId: currentPath, models: { models: [model], providers: [{ id: "test", name: "Test", authReady: true }] },
		state: { snapshot: currentPath ? { cwd: "/workspace", model, trajectory: [], messages: [], userTurns: [], queue: { steering: [], followUp: [] } } : null,
			messages: [], tools: {}, growth: { rounds: [], error: null }, extensionStatuses: {}, extensionDialogs: [], extensionNotices: [], connected: true },
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
// 新会话页不再自动选模型：这些用例模拟用户在 /workspace 里选过 test-model（记住的选择），草稿才能发出去
beforeEach(() => { localStorage.clear(); writeRememberedHeroModel(localStorage, "/workspace", { provider: model.provider, id: model.id }); mocks.sendCommand.mockReset().mockResolvedValue({ success: true }); mocks.newSession.mockReset().mockResolvedValue("/created"); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("AppShell session-owned composer drafts", () => {
	it("loads skills, templates and extension commands before sending the first Hero message", async () => {
		const resources = { skills: [{ name: "workspace-skill", description: "A skill" }], promptTemplates: [{ name: "workspace-template", description: "A template" }], extensionCommands: [{ name: "workspace-command", description: "A command" }] };
		const fetcher = vi.fn((url: string) => Promise.resolve(response(url.startsWith("/api/agent/resources") ? resources : { modelThinkingLevels: {} })));
		vi.stubGlobal("fetch", fetcher);
		render(<AppShell />);
		go("New hero");
		fireEvent.change(textarea(), { target: { value: "/" } });
		expect(await screen.findByText("skill:workspace-skill")).toBeTruthy();
		expect(screen.getByText("workspace-template")).toBeTruthy();
		expect(screen.getByText("workspace-command")).toBeTruthy();
		expect(fetcher).toHaveBeenCalledWith("/api/agent/resources?cwd=%2Fworkspace", expect.any(Object));
		expect(mocks.newSession).not.toHaveBeenCalled();
		expect(mocks.sendCommand).not.toHaveBeenCalled();
	});

	it("ignores late resource responses from a previously selected workspace", async () => {
		const old = deferred<ReturnType<typeof response>>();
		vi.stubGlobal("fetch", vi.fn((url: string) => url === "/api/agent/resources?cwd=%2Fworkspace" ? old.promise : Promise.resolve(response({ modelThinkingLevels: {}, skills: [{ name: "other-skill", description: "Other workspace" }], promptTemplates: [], extensionCommands: [] }))));
		writeRememberedHeroModel(localStorage, "/other", { provider: model.provider, id: model.id });
		render(<AppShell />);
		go("New hero");
		go("New other hero");
		fireEvent.change(textarea(), { target: { value: "/" } });
		expect(await screen.findByText("skill:other-skill")).toBeTruthy();
		await act(async () => old.resolve(response({ skills: [{ name: "stale-skill", description: "Old workspace" }], promptTemplates: [], extensionCommands: [] })));
		expect(screen.queryByText("skill:stale-skill")).toBeNull();
		expect(screen.getByText("skill:other-skill")).toBeTruthy();
	});

	it("keeps cached commands available when switching between new and existing sessions during revalidation", async () => {
		const resources = { skills: [{ name: "shared-skill", description: "Shared" }], promptTemplates: [], extensionCommands: [{ name: "fast", description: "Toggle fast" }] };
		const pending = deferred<ReturnType<typeof response>>();
		let requests = 0;
		vi.stubGlobal("fetch", vi.fn((url: string) => {
			if (url.startsWith("/api/agent/resources")) return ++requests === 1 ? Promise.resolve(response(resources)) : pending.promise;
			return Promise.resolve(response({ modelThinkingLevels: {} }));
		}));
		render(<AppShell />);
		fireEvent.change(textarea(), { target: { value: "/" } });
		expect(await screen.findByText("skill:shared-skill")).toBeTruthy();
		go("New hero");
		fireEvent.change(textarea(), { target: { value: "/" } });
		expect(screen.getByText("fast")).toBeTruthy();
		go("Open B");
		fireEvent.change(textarea(), { target: { value: "/" } });
		expect(screen.getByText("skill:shared-skill")).toBeTruthy();
		expect(screen.getByText("fast")).toBeTruthy();
	});

	it("reserves layout space for Hero references and images instead of covering the workspace selector", async () => {
		vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(response({ modelThinkingLevels: {}, skills: [], promptTemplates: [], extensionCommands: [] }))));
		render(<AppShell />);
		fireEvent.click(screen.getByTestId("drawer-toggle"));
		go("New hero");
		go("Reference file");
		fireEvent.paste(textarea(), { clipboardData: { files: [new File(["image"], "shot.png", { type: "image/png" })] } });
		await screen.findByLabelText("点击放大预览");
		const attachments = screen.getByTestId("composer-attachments");
		expect(attachments.classList.contains("absolute")).toBe(false);
		expect(attachments.classList.contains("relative")).toBe(true);
		expect(screen.getByTestId("composer-references").textContent).toContain("ref.txt");
	});

	it("consumes file references as chips in the target draft without remount/session replay", async () => {
		render(<AppShell />);
		// 项目栏已降级成抽屉的入口：这里只要把抽屉打开即可 ——
		// 本文件的 next/dynamic 桩在收到 onReference 时就会渲染 Reference file 按钮，
		// 而 AppShell 正是把 onReference 传给了 DrawerPanel。
		fireEvent.click(screen.getByTestId("drawer-toggle"));
		fireEvent.change(textarea(), { target: { value: "draft A" } });
		textarea().setSelectionRange(7, 7);
		go("Reference file");
		// 引用不再混进正文:正文保持原样,引用进独立轨(发送时才拼成 @路径)
		expect(textarea().value).toBe("draft A");
		expect(screen.getByTestId("composer-references").textContent).toContain("ref.txt");
		remount();
		expect(textarea().value).toBe("draft A");
		expect(screen.getByTestId("composer-references").textContent).toContain("ref.txt");
		go("Open B");
		expect(textarea().value).toBe("");
		expect(screen.queryByTestId("composer-references")).toBeNull();
		go("Open A");
		fireEvent.keyDown(textarea(), { key: "Enter" });
		await waitFor(() => expect(textarea().value).toBe(""));
		await waitFor(() => expect(mocks.sendCommand).toHaveBeenCalledWith(expect.objectContaining({ cmd: "prompt", text: "draft A\n\n@ref.txt" })));
		// 发送成功后引用轨清空,不能复活
		await waitFor(() => expect(screen.queryByTestId("composer-references")).toBeNull());
		remount();
		expect(screen.queryByTestId("composer-references")).toBeNull();
		go("New hero");
		go("Reference file");
		expect(textarea().value).toBe("");
		expect(screen.getByTestId("composer-references").textContent).toContain("ref.txt");
		fireEvent.keyDown(textarea(), { key: "Enter" });
		await waitFor(() => expect(screen.queryByTestId("composer-references")).toBeNull());
		remount();
		expect(screen.queryByTestId("composer-references")).toBeNull();
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
		fireEvent.click(screen.getByRole("button", { name: "删除 a.txt" }));
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

	it("does not preselect a model for a workspace with no remembered choice, so the composer stays blocked", async () => {
		localStorage.clear();
		render(<AppShell />);
		go("New hero");
		expect(textarea().disabled).toBe(true);
		fireEvent.change(textarea(), { target: { value: "too early" } });
		fireEvent.keyDown(textarea(), { key: "Enter" });
		expect(mocks.newSession).not.toHaveBeenCalled();
		expect(mocks.sendCommand).not.toHaveBeenCalled();
	});
});
