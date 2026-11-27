// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AppShell } from "@/components/AppShell";
import { writeRememberedHeroModel } from "@/lib/hero-model-memory";

class EventSourceFixture {
	static instances: EventSourceFixture[] = [];
	closed = false;
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: string }) => void) | null = null;
	onerror: (() => void) | null = null;
	constructor(readonly url: string) {
		EventSourceFixture.instances.push(this);
	}
	addEventListener() {}
	close() {
		this.closed = true;
	}
	emit(payload: Record<string, unknown>) {
		this.onmessage?.({ data: JSON.stringify(payload) });
	}
}

vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("@/lib/theme", () => ({ syncPebrelTheme: () => {} }));
vi.mock("@/hooks/useGrowth", () => ({
	useGrowth: () => ({
		available: false, loading: false, error: null, rounds: [], selected: null, scope: "session", range: undefined,
		changes: [], changesReady: false, tree: null, filePaths: [], expanded: new Set<string>(), fresh: false,
		selectLatest: () => {}, select: () => {}, prev: () => {}, next: () => {}, setScope: () => {}, toggleDir: () => {}, revealPath: () => {},
		expandAll: () => {}, collapseAll: () => {}, expandLazy: () => {}, refresh: () => {}, recordNow: () => {},
	}),
}));
vi.mock("@/components/SessionSidebar", () => ({
	SessionSidebar: (props: { onNewInWorkspace: (cwd: string) => void }) => (
		<button onClick={() => props.onNewInWorkspace("/workspace")}>New hero</button>
	),
}));
vi.mock("@/components/ChatWindow", () => ({ ChatWindow: () => null, SessionStatsBar: () => null }));
vi.mock("@/components/ExtensionUI", () => ({
	ExtensionDialogHost: () => null,
	ExtensionNotices: ({ children }: { children?: React.ReactNode }) => children ?? null,
	ExtensionWidgets: () => null,
}));

const model = {
	provider: "test-provider",
	id: "reasoner-1",
	name: "Reasoner 1",
	reasoning: true,
	contextWindow: 16384,
	thinkingLevels: ["off", "minimal", "low", "medium", "high"],
};

const jsonResponse = (data: unknown) => new Response(JSON.stringify({ success: true, data }), {
	headers: { "Content-Type": "application/json" },
});

describe("Hero draft real-time settings & resource sync", () => {
	let currentDefaultThinking = "low";
	let currentPrompts: Array<{ name: string; description: string }> = [{ name: "initial-tpl", description: "Initial" }];

	beforeEach(() => {
		localStorage.clear();
		sessionStorage.clear();
		EventSourceFixture.instances = [];
		currentDefaultThinking = "low";
		currentPrompts = [{ name: "initial-tpl", description: "Initial" }];
		writeRememberedHeroModel(localStorage, "/workspace", { provider: model.provider, id: model.id });
		vi.stubGlobal("EventSource", EventSourceFixture);
		vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.startsWith("/api/sessions")) {
				return jsonResponse({
					sessions: [],
					running: {},
					workspaceRegistry: { workspaces: ["/workspace"], removedWorkspaces: [], aliases: {}, archivedSessions: [] },
				});
			}
			if (url.startsWith("/api/models/defaults")) {
				return jsonResponse({
					model: { provider: model.provider, id: model.id },
					defaultThinkingLevel: currentDefaultThinking,
					modelThinkingLevels: {},
				});
			}
			if (url.startsWith("/api/models")) {
				return jsonResponse({
					providers: [{ id: model.provider, name: "Test", authReady: true }],
					models: [model],
				});
			}
			if (url.startsWith("/api/agent/resources")) {
				return jsonResponse({
					skills: [],
					promptTemplates: currentPrompts,
					extensionCommands: [],
				});
			}
			return jsonResponse({});
		}));
	});

	afterEach(() => {
		cleanup();
		localStorage.clear();
		vi.unstubAllGlobals();
	});

	it("updates Hero default thinking level and slash templates in real time without page reload while preserving explicit user selection", async () => {
		const rendered = render(<AppShell />);
		fireEvent.click(screen.getByRole("button", { name: "New hero" }));

		const modelChip = () => screen.getByRole("button", { name: /Reasoner 1/ });
		await waitFor(() => expect(modelChip().textContent).toContain("low"));

		const stream = await vi.waitFor(() => {
			const found = EventSourceFixture.instances.find((item) => item.url.includes("/api/agent/resources?cwd=%2Fworkspace&stream=1"));
			expect(found).toBeDefined();
			return found!;
		});

		// Simulate external edit to .pi/settings.json (low -> high) + adding a new prompt template
		currentDefaultThinking = "high";
		currentPrompts = [
			{ name: "initial-tpl", description: "Initial" },
			{ name: "new-disk-tpl", description: "From disk" },
		];
		await act(async () => {
			stream.emit({ type: "workspace_changed", version: 1, ts: Date.now() });
		});

		await waitFor(() => expect(modelChip().textContent).toContain("high"));
		fireEvent.change(screen.getByRole("textbox"), { target: { value: "/" } });
		expect(await screen.findByText("new-disk-tpl")).toBeTruthy();

		// Now user explicitly selects "minimal" in Hero; subsequent external default changes must NOT override it
		fireEvent.change(screen.getByRole("textbox"), { target: { value: "" } });
		fireEvent.click(modelChip());
		fireEvent.click(screen.getByRole("button", { name: /思考:\s*high/ }));
		fireEvent.click(screen.getByRole("menuitemradio", { name: /minimal/ }));
		await waitFor(() => expect(modelChip().textContent).toContain("minimal"));

		currentDefaultThinking = "medium";
		await act(async () => {
			stream.emit({ type: "workspace_changed", version: 2, ts: Date.now() });
		});
		await waitFor(() => expect(modelChip().textContent).toContain("minimal"));

		rendered.unmount();
		expect(stream.closed).toBe(true);
	});
});
