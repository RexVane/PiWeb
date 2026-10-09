// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { AppShell } from "@/components/layout/AppShell";
import type { ModelDefaults } from "@/lib/models/thinking";

const levels = ["off", "minimal", "low", "medium", "high"];
const mocks = vi.hoisted(() => ({
	sendCommand: vi.fn(),
	newSession: vi.fn(),
	refreshModels: vi.fn(),
	defaults: null as ModelDefaults | null,
}));
const noop = () => {};
vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("@/lib/ui/theme", () => ({ syncPebrelTheme: () => {} }));
vi.mock("@/hooks/useGrowth", () => ({ useGrowth: () => ({ rounds: [], select: () => {} }) }));
vi.mock("@/components/chat/ChatWindow", () => ({ ChatWindow: () => null, SessionStatsBar: () => null }));
vi.mock("@/components/chat/ExtensionUI", () => ({ ExtensionDialogHost: () => null, ExtensionNotices: () => null }));
vi.mock("@/components/layout/SessionSidebar", () => ({ SessionSidebar: (props: any) => <button onClick={() => props.onNewInWorkspace("/workspace")}>New hero</button> }));
vi.mock("@/hooks/usePiWeb", () => ({ usePiWeb: () => {
	const [currentPath, setCurrentPath] = useState<string | null>(null);
	return {
		sessions: [], archivedSessions: [], archivedSessionPaths: [], addedWorkspaces: ["/workspace"], removedWorkspaces: [], workspaceAliases: {},
		currentPath, currentId: currentPath,
		models: {
			models: [
				{ provider: "p", id: "fast", name: "Fast", reasoning: true, thinkingLevels: levels, contextWindow: 1000 },
				{ provider: "p", id: "deep", name: "Deep", reasoning: true, thinkingLevels: levels, contextWindow: 1000 },
				{ provider: "q", id: "locked", name: "Locked", reasoning: true, thinkingLevels: levels, contextWindow: 1000 },
			],
			providers: [{ id: "p", name: "Prov", authReady: true }, { id: "q", name: "Q", authReady: false }],
			defaults: mocks.defaults,
		},
		state: { snapshot: null, messages: [], tools: {}, growth: { rounds: [], error: null }, extensionStatuses: {}, extensionDialogs: [], extensionNotices: [], connected: true },
		getWorkspaceName: (cwd: string) => cwd, sendCommand: mocks.sendCommand,
		newSession: async (...args: unknown[]) => { const path = await mocks.newSession(...args); if (path) setCurrentPath(path); return path; },
		openSession: setCurrentPath, closeSession: () => setCurrentPath(null),
		renameWorkspace: noop, patchSessionName: noop, archiveSession: noop, unarchiveSession: noop, resync: noop,
		setGroupBy: noop, setOrderBy: noop, addWorkspaceByPicker: noop, removeWorkspace: noop, refreshModels: mocks.refreshModels,
		setToolPreset: noop, clearError: noop, clearCompaction: noop, setError: noop, answerExtensionDialog: noop, dismissExtensionNotice: noop,
	};
} }));

beforeEach(() => {
	localStorage.clear();
	mocks.sendCommand.mockReset().mockResolvedValue({ success: true });
	mocks.newSession.mockReset().mockResolvedValue("/created");
	mocks.refreshModels.mockReset().mockResolvedValue(undefined);
	mocks.defaults = { provider: "p", modelId: "deep", thinkingLevel: "low", modelThinkingLevels: { "p/fast": "minimal" } };
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function hero() {
	render(<AppShell />);
	fireEvent.click(screen.getByRole("button", { name: "New hero" }));
}
async function send() {
	const box = screen.getByRole("textbox");
	fireEvent.change(box, { target: { value: "hello" } });
	fireEvent.keyDown(box, { key: "Enter" });
	await waitFor(() => expect(mocks.newSession).toHaveBeenCalled());
	return mocks.newSession.mock.calls[0];
}
const openSelector = (name: string | RegExp) => fireEvent.click(screen.getByRole("button", { name }));

describe("new session page follows pi's default model and thinking level", () => {
	it("shows pi's default and lets pi apply it when the user changes nothing", async () => {
		hero();
		expect(screen.getByRole("button", { name: "Prov/Deep · low" })).toBeTruthy();
		expect(await send()).toEqual(["/workspace", { provider: undefined, modelId: undefined, thinking: undefined }]);
	});

	it("sends only the thinking level the user picked for pi's default model", async () => {
		hero();
		openSelector("Prov/Deep · low");
		fireEvent.click(screen.getByRole("button", { name: /思考/ }));
		fireEvent.click(screen.getByRole("menuitemradio", { name: /^high/ }));
		expect(screen.getByRole("button", { name: "Prov/Deep · high" })).toBeTruthy();
		expect(await send()).toEqual(["/workspace", { provider: undefined, modelId: undefined, thinking: "high" }]);
	});

	it("sends a picked model with the level the page shows for it (per-model default first)", async () => {
		hero();
		openSelector("Prov/Deep · low");
		fireEvent.click(screen.getByRole("menuitemradio", { name: /Fast/ }));
		expect(screen.getByRole("button", { name: "Prov/Fast · minimal" })).toBeTruthy();
		expect(await send()).toEqual(["/workspace", { provider: "p", modelId: "fast", thinking: "minimal" }]);
	});

	it.each([
		["no default", null],
		["a default without credentials", { provider: "q", modelId: "locked", thinkingLevel: null, modelThinkingLevels: {} }],
	])("falls back to the first usable model with explicit settings when pi has %s", async (_, defaults) => {
		mocks.defaults = defaults as ModelDefaults | null;
		hero();
		expect(screen.getByRole("button", { name: "Prov/Fast · medium" })).toBeTruthy();
		expect(await send()).toEqual(["/workspace", { provider: "p", modelId: "fast", thinking: "medium" }]);
	});

	it("saves the shown model and level as pi's default, updating the model's own level when it has one", async () => {
		const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: true, status: 200, json: async () => ({ success: true, data: {} }) }));
		vi.stubGlobal("fetch", fetchMock);
		hero();
		openSelector("Prov/Deep · low");
		fireEvent.click(screen.getByRole("menuitemradio", { name: /Fast/ }));
		openSelector("Prov/Fast · minimal");
		fireEvent.click(screen.getByRole("button", { name: "设为默认" }));
		await waitFor(() => expect(mocks.refreshModels).toHaveBeenCalled());
		const [, init] = fetchMock.mock.calls.find(([target]) => target === "/api/pi-settings")!;
		expect(init?.method).toBe("PUT");
		expect(JSON.parse(String(init?.body))).toEqual({
			defaultModel: { provider: "p", modelId: "fast" },
			thinking: { defaultLevel: "minimal", modelLevels: { "p/fast": "minimal" } },
		});
	});
});
