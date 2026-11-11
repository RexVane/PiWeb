// @vitest-environment jsdom
/** 真实输入框权限入口、AppShell 与 usePiWeb，只替换网络与无关面板。 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AppShell } from "@/components/AppShell";

vi.mock("next/dynamic", async () => {
	const { SettingsPanel } = await import("@/components/SettingsPanel");
	return { default: (loader: () => unknown) => loader.toString().includes("SettingsPanel") ? SettingsPanel : () => null };
});
vi.mock("@/lib/theme", () => ({ syncPebrelTheme: () => {}, applyPebrelTheme: () => {}, loadPebrelTheme: () => "dsh", loadThemeMode: () => "system" }));
vi.mock("@/hooks/useGrowth", () => ({ useGrowth: () => ({ rounds: [], select: () => {}, selectLatest: () => {} }) }));
vi.mock("@/components/ExtensionUI", () => ({ ExtensionDialogHost: () => null, ExtensionNotices: () => null }));
vi.mock("@/components/SessionSidebar", () => ({ SessionSidebar: (props: any) => <>
	<button onClick={() => props.onOpen("/cold.jsonl")}>Open cold</button>
	<button onClick={() => props.onOpen("/other.jsonl")}>Open other</button>
	<button onClick={props.onOpenSettings}>Settings</button>
	<button onClick={props.onNew}>New chat</button>
</> }));

class EventSourceFixture {
	static instances: EventSourceFixture[] = [];
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: string }) => void) | null = null;
	onerror: (() => void) | null = null;
	close() {}
	constructor(readonly url: string) { EventSourceFixture.instances.push(this); }
	emit(event: Record<string, unknown>) { this.onmessage?.({ data: JSON.stringify(event) }); }
}
const response = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { headers: { "Content-Type": "application/json" } });
const commands: { url: string; cmd: string; preset?: string }[] = [];
let setPermission: () => Promise<Response>;
beforeEach(() => {
	localStorage.clear();
	EventSourceFixture.instances = [];
	commands.length = 0;
	setPermission = async () => response({});
	vi.stubGlobal("EventSource", EventSourceFixture);
	vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		if (init?.method === "POST" && url.startsWith("/api/agent/")) {
			const command = JSON.parse(String(init.body));
			commands.push({ url, ...command });
			if (command.cmd === "setToolPreset") return setPermission();
			return response({});
		}
		return response(url === "/api/sessions" ? { sessions: [], running: {}, workspaceRegistry: { workspaces: [], removedWorkspaces: [], aliases: {}, archivedSessions: [] } }
			: url === "/api/models" ? { models: [], providers: [] }
			: url === "/api/version" ? { piWeb: "test", piEngine: "test" }
			: { compaction: {}, retry: {}, modelThinkingLevels: {} });
	}));
});
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); });
const click = (name: string) => fireEvent.click(screen.getByRole("button", { name }));
async function open(name = "Open cold", extra: Record<string, unknown> = {}) {
	const count = EventSourceFixture.instances.length;
	click(name);
	await waitFor(() => expect(EventSourceFixture.instances).toHaveLength(count + 1));
	const stream = EventSourceFixture.instances.at(-1)!;
	await act(async () => stream.emit({ type: "snapshot", snapshot: {
		cwd: "/workspace", messages: [], trajectory: [], userTurns: [], toolPreset: "standard", toolPreferenceSaved: true,
		model: { provider: "test", id: "m", name: "Test model" }, tools: { active: ["read", "bash"], all: [{ name: "read" }, { name: "bash" }] },
		queue: { steering: [], followUp: [] }, isStreaming: false, contextUsage: null, ...extra,
	} }));
	return stream;
}
function choosePermission(name: string) {
	fireEvent.click(screen.getByTestId("permission-trigger"));
	fireEvent.click(screen.getByRole("option", { name: new RegExp(`^${name}`) }));
}

it("sets the new-chat permission from the composer without starting an agent or exposing a tools settings page", async () => {
	render(<AppShell />);
	choosePermission("只读访问");
	await waitFor(() => expect(screen.getByTestId("permission-trigger").textContent).toBe("只读访问"));
	expect(localStorage.getItem("piweb.toolPreset")).toBe("readonly");
	expect(commands).toEqual([]);
	click("Settings");
	expect(screen.queryByRole("button", { name: "工具启用情况" })).toBeNull();
});

it("replaces a cold session's custom selection only after the permission command succeeds", async () => {
	render(<AppShell />);
	await open("Open cold", { customActiveTools: ["read"] });
	expect(screen.getByTestId("permission-trigger").textContent).toBe("自定义");
	choosePermission("常规编辑");
	await waitFor(() => expect(screen.getByTestId("permission-trigger").textContent).toBe("常规编辑"));
	expect(commands).toHaveLength(1);
	expect(commands[0]).toMatchObject({ cmd: "setToolPreset", preset: "standard" });
	expect(commands[0].url).toContain("/api/agent/");
});

it("disables sending during a save and retains the previous permission when saving fails", async () => {
	render(<AppShell />);
	await open();
	fireEvent.change(screen.getByRole("textbox"), { target: { value: "draft" } });
	let resolve!: (response: Response) => void;
	setPermission = () => new Promise((yes) => { resolve = yes; });
	choosePermission("完全访问");
	await waitFor(() => expect(commands).toHaveLength(1));
	expect((screen.getByTestId("permission-trigger") as HTMLButtonElement).disabled).toBe(true);
	expect((screen.getByTitle("发送") as HTMLButtonElement).disabled).toBe(true);
	fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
	expect(commands).toHaveLength(1);
	await act(async () => resolve(new Response(JSON.stringify({ success: false, error: "permission save failed" }), { status: 503 })));
	expect(screen.getByTestId("permission-trigger").textContent).toBe("常规编辑");
	expect(localStorage.getItem("piweb.toolPreset")).toBeNull();
	expect((screen.getByTitle("发送") as HTMLButtonElement).disabled).toBe(false);
});

it("ignores a previous session's late success and failure after switching sessions", async () => {
	render(<AppShell />);
	await open();
	let resolve!: (response: Response) => void;
	setPermission = () => new Promise((yes) => { resolve = yes; });
	choosePermission("完全访问");
	await waitFor(() => expect(commands).toHaveLength(1));
	await open("Open other", { toolPreset: "readonly" });
	await act(async () => resolve(response({})));
	expect(screen.getByTestId("permission-trigger").textContent).toBe("只读访问");
	expect(localStorage.getItem("piweb.toolPreset")).toBeNull();
	choosePermission("常规编辑");
	await waitFor(() => expect(commands).toHaveLength(2));
	await open("Open cold", { toolPreset: "full" });
	await act(async () => resolve(new Response(JSON.stringify({ success: false, error: "old session failed" }), { status: 503 })));
	expect(screen.getByTestId("permission-trigger").textContent).toBe("完全访问");
	expect(screen.queryByText("old session failed")).toBeNull();
});

it("changes the actual session permission while a task is running", async () => {
	render(<AppShell />);
	const stream = await open("Open cold", { isStreaming: true, toolPreset: "full" });
	const trigger = screen.getByTestId("permission-trigger") as HTMLButtonElement;
	expect(trigger.disabled).toBe(false);
	choosePermission("只读访问");
	await waitFor(() => expect(trigger.textContent).toBe("只读访问"));
	expect(commands).toHaveLength(1);
	expect(commands[0]).toMatchObject({ cmd: "setToolPreset", preset: "readonly" });
	expect(localStorage.getItem("piweb.toolPreset")).toBe("readonly");
	await act(async () => stream.emit({ type: "status", isStreaming: false }));
	expect(trigger.textContent).toBe("只读访问");
});
