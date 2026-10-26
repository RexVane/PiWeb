// @vitest-environment jsdom
/** 真实 AppShell、usePiWeb 和设置页，只替换网络与无关面板。 */
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
const commands: { url: string; cmd: string; names?: string[] }[] = [];
let prepare: () => Promise<Response>;
beforeEach(() => {
	localStorage.clear();
	EventSourceFixture.instances = [];
	commands.length = 0;
	prepare = async () => response({});
	vi.stubGlobal("EventSource", EventSourceFixture);
	vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		if (init?.method === "POST" && url.startsWith("/api/agent/")) {
			const command = JSON.parse(String(init.body));
			commands.push({ url, ...command });
			if (command.cmd === "prepare") return prepare();
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
async function open(name = "Open cold", tools = { active: [] as string[], all: [] as { name: string }[] }) {
	const count = EventSourceFixture.instances.length;
	click(name);
	await waitFor(() => expect(EventSourceFixture.instances).toHaveLength(count + 1));
	const stream = EventSourceFixture.instances.at(-1)!;
	await act(async () => stream.emit({ type: "snapshot", snapshot: {
		cwd: "/workspace", messages: [], trajectory: [], userTurns: [], toolPreset: "standard", tools,
		queue: { steering: [], followUp: [] }, isStreaming: false, contextUsage: null,
	} }));
	return stream;
}
async function settings() {
	click("Settings");
	click("工具启用情况");
}

it("loads tools for an open cold session and toggles the selected session's tools", async () => {
	render(<AppShell />);
	const stream = await open();
	let resolve!: (response: Response) => void;
	prepare = () => new Promise((yes) => { resolve = yes; });
	await settings();
	await waitFor(() => expect(commands.filter((c) => c.cmd === "prepare")).toHaveLength(1));
	expect(screen.getByText("正在加载当前会话的工具…")).toBeTruthy();
	expect(screen.queryByText("打开一个会话后，这里会显示可用工具并支持逐个启停。")).toBeNull();
	await act(async () => {
		stream.emit({ type: "tools", active: ["read", "bash"], all: ["read", "bash", "probe_tool"], ts: 1 });
		resolve(response({}));
	});
	expect(await screen.findByRole("switch", { name: "probe_tool" })).toBeTruthy();
	fireEvent.click(screen.getByRole("switch", { name: "probe_tool" }));
	await waitFor(() => expect(commands.at(-1)).toMatchObject({ cmd: "setActiveTools", names: ["read", "bash", "probe_tool"] }));
	expect(commands.at(-1)!.url).toBe(commands[0].url);
});

it("shows a load error and allows retrying instead of claiming there is no session", async () => {
	render(<AppShell />);
	const stream = await open();
	prepare = async () => new Response(JSON.stringify({ success: false, error: "tool load failed" }), { status: 503 });
	await settings();
	expect(await screen.findByText("tool load failed", { selector: 'div[role="alert"]' })).toBeTruthy();
	prepare = async () => { stream.emit({ type: "tools", active: ["read"], all: ["read", "bash"], ts: 1 }); return response({}); };
	click("重试");
	expect(await screen.findByRole("switch", { name: "bash" })).toBeTruthy();
	expect(commands.filter((c) => c.cmd === "prepare")).toHaveLength(2);
});

it("does not prepare an agent without an open session or when its tools are already loaded", async () => {
	render(<AppShell />);
	await settings();
	expect(screen.getByText("打开一个会话后，这里会显示可用工具并支持逐个启停。")).toBeTruthy();
	expect(commands).toEqual([]);
	await open("Open cold", { active: ["read"], all: [{ name: "read" }, { name: "bash" }] });
	expect(screen.getByRole("switch", { name: "bash" })).toBeTruthy();
	expect(commands).toEqual([]);
});

it("ignores an old session's late failure after switching to another session", async () => {
	render(<AppShell />);
	await open();
	let resolve!: (response: Response) => void;
	prepare = () => new Promise((yes) => { resolve = yes; });
	await settings();
	await waitFor(() => expect(commands.filter((c) => c.cmd === "prepare")).toHaveLength(1));
	await open("Open other", { active: ["bash"], all: [{ name: "bash" }] });
	await act(async () => resolve(new Response(JSON.stringify({ success: false, error: "old session failed" }), { status: 503 })));
	expect(screen.getByRole("switch", { name: "bash" })).toBeTruthy();
	expect(screen.queryByText("old session failed", { selector: 'div[role="alert"]' })).toBeNull();
});
