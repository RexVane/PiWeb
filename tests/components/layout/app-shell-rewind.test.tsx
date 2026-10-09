// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AppShell } from "@/components/layout/AppShell";

const image = { type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" };
const mocks = vi.hoisted(() => ({ sendCommand: vi.fn() }));
const noop = () => {};
vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("@/lib/ui/theme", () => ({ syncPebrelTheme: () => {} }));
vi.mock("@/hooks/useGrowth", () => ({ useGrowth: () => ({ rounds: [], select: () => {} }) }));
vi.mock("@/components/chat/ExtensionUI", () => ({ ExtensionDialogHost: () => null, ExtensionNotices: () => null }));
vi.mock("@/components/layout/SessionSidebar", () => ({ SessionSidebar: () => null }));
// 对话区只留两个按钮，直接调 AppShell 交给它的撤回 / 编辑回调
vi.mock("@/components/chat/ChatWindow", () => ({
	SessionStatsBar: () => null,
	ChatWindow: (props: any) => <>
		<button onClick={() => void props.onRecallMessage("u1", "client text", [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }])}>Recall</button>
		<button onClick={() => void props.onEditMessage("u1", "edited text", [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }])}>Edit</button>
	</>,
}));
vi.mock("@/hooks/usePiWeb", () => ({ usePiWeb: () => ({
	sessions: [{ path: "/s", cwd: "/w", name: "s" }], archivedSessions: [], archivedSessionPaths: [], addedWorkspaces: ["/w"], removedWorkspaces: [], workspaceAliases: {},
	currentPath: "/s", currentId: "s",
	models: { models: [], providers: [], defaults: null },
	state: { snapshot: { cwd: "/w", trajectory: [], messages: [], queue: { steering: [], followUp: [] } }, messages: [], tools: {}, growth: { rounds: [], error: null },
		extensionStatuses: {}, extensionDialogs: [], extensionNotices: [], connected: true },
	getWorkspaceName: (cwd: string) => cwd, sendCommand: mocks.sendCommand, newSession: noop, openSession: noop, closeSession: noop,
	renameWorkspace: noop, patchSessionName: noop, archiveSession: noop, unarchiveSession: noop, resync: noop,
	setGroupBy: noop, setOrderBy: noop, addWorkspaceByPicker: noop, removeWorkspace: noop, refreshModels: noop,
	setToolPreset: noop, clearError: noop, clearCompaction: noop, setError: noop, answerExtensionDialog: noop, dismissExtensionNotice: noop,
}) }));

beforeEach(() => { localStorage.clear(); mocks.sendCommand.mockReset(); });
afterEach(cleanup);

const composer = () => screen.getByRole("textbox") as HTMLTextAreaElement;

describe("withdrawn and failed edited messages land back in the composer", () => {
	it("puts the withdrawn text (server's copy), its images and cleared queue ahead of the existing draft", async () => {
		mocks.sendCommand.mockResolvedValue({ success: true, data: { editorText: "server text", cleared: { steering: ["queued steer"], followUp: ["queued follow-up"] } } });
		render(<AppShell />);
		fireEvent.change(composer(), { target: { value: "half-typed" } });
		fireEvent.click(screen.getByRole("button", { name: "Recall" }));
		await waitFor(() => expect(composer().value).toBe("server text\n\nqueued steer\n\nqueued follow-up\n\nhalf-typed"));
		expect(mocks.sendCommand).toHaveBeenCalledWith({ cmd: "rewind", entryId: "u1" });
		expect(document.querySelectorAll('[data-testid="composer"] img').length).toBe(1);
	});

	it("restores only the cleared queue when the withdraw fails", async () => {
		mocks.sendCommand.mockResolvedValue({ success: false, error: "cancelled", data: { cleared: { steering: [], followUp: ["queued"] } } });
		render(<AppShell />);
		fireEvent.click(screen.getByRole("button", { name: "Recall" }));
		await waitFor(() => expect(composer().value).toBe("queued"));
		expect(document.querySelectorAll('[data-testid="composer"] img').length).toBe(0);
	});

	it("keeps an edited message that was not accepted after the history was rewound", async () => {
		mocks.sendCommand.mockResolvedValue({ success: false, error: "missing credentials", data: { cleared: { steering: [], followUp: [] }, rewound: true } });
		render(<AppShell />);
		fireEvent.click(screen.getByRole("button", { name: "Edit" }));
		await waitFor(() => expect(composer().value).toBe("edited text"));
		expect(mocks.sendCommand).toHaveBeenCalledWith({ cmd: "rewind", entryId: "u1", text: "edited text", images: [image] });
		expect(document.querySelectorAll('[data-testid="composer"] img').length).toBe(1);
	});

	it("leaves the composer alone after a successful edit", async () => {
		mocks.sendCommand.mockResolvedValue({ success: true, data: { accepted: true, cleared: { steering: [], followUp: [] }, rewound: true } });
		render(<AppShell />);
		fireEvent.click(screen.getByRole("button", { name: "Edit" }));
		await waitFor(() => expect(mocks.sendCommand).toHaveBeenCalled());
		expect(composer().value).toBe("");
	});
});
