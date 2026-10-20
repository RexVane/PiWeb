// @vitest-environment jsdom
/** 真实 AppShell + usePiWeb + 输入框：首个空快照后只收到增量，圆圈也应立即出现。 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AppShell } from "@/components/AppShell";

const model = { id: "test-model", name: "Test", provider: "test", reasoning: false, contextWindow: 1000, thinkingLevels: [] };
const noop = () => {};
vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("@/lib/theme", () => ({ syncPebrelTheme: () => {} }));
vi.mock("@/hooks/useGrowth", () => ({ useGrowth: () => ({ rounds: [], select: noop, selectLatest: noop }) }));
vi.mock("@/components/ExtensionUI", () => ({ ExtensionDialogHost: () => null, ExtensionNotices: () => null }));
vi.mock("@/components/SessionSidebar", () => ({ SessionSidebar: (props: { onOpen: (path: string) => void }) => <>
	<button onClick={() => props.onOpen("/new.jsonl")}>Open new</button>
	<button onClick={() => props.onOpen("/empty.jsonl")}>Open empty</button>
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
const userMessage = { role: "user", id: "u1", content: [{ type: "text", text: "首条消息" }], timestamp: 1 };
const snapshot = (messages: unknown[] = []) => ({
	cwd: "/workspace", model, messages, trajectory: [], userTurns: [], toolPreset: "standard",
	queue: { steering: [], followUp: [] }, tools: { active: [], all: [] }, isStreaming: false,
	contextUsage: null,
});
async function open(name: string, messages: unknown[] = []) {
	const count = EventSourceFixture.instances.length;
	fireEvent.click(screen.getByRole("button", { name }));
	await waitFor(() => expect(EventSourceFixture.instances.length).toBe(count + 1));
	const stream = EventSourceFixture.instances.at(-1)!;
	await act(async () => stream.emit({ type: "snapshot", snapshot: snapshot(messages) }));
	return stream;
}

beforeEach(() => {
	localStorage.clear();
	EventSourceFixture.instances = [];
	vi.stubGlobal("EventSource", EventSourceFixture);
	vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
		const url = String(input);
		const data = url === "/api/sessions" ? { sessions: [], running: {}, workspaceRegistry: { workspaces: [], removedWorkspaces: [], aliases: {}, archivedSessions: [] } }
			: url === "/api/models" ? { models: [model], providers: [{ id: "test", name: "Test", authReady: true }] }
			: { modelThinkingLevels: {} };
		return new Response(JSON.stringify({ success: true, data }), { headers: { "Content-Type": "application/json" } });
	}));
});
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); });

it.each(["message", "delta"])("shows the context ring on the first %s event without another snapshot", async (first) => {
	render(<AppShell />);
	expect(screen.queryByRole("button", { name: /上下文/ })).toBeNull();
	const stream = await open("Open new");
	expect(screen.queryByRole("button", { name: /上下文/ })).toBeNull();

	await act(async () => {
		stream.emit({ type: "status", isStreaming: true, ts: 1 });
		stream.emit(first === "message" ? { type: "message", phase: "start", message: userMessage, ts: 1 }
			: { type: "delta", messageId: "a1", kind: "text", contentIndex: 0, delta: "正在回答", ts: 1 });
	});
	const ring = await screen.findByRole("button", { name: "上下文用量未知" });
	fireEvent.click(ring);
	expect(screen.getByText(first === "message" ? "User Messages" : "Agent Text")).toBeTruthy();
	fireEvent.click(ring);

	await act(async () => {
		stream.emit({ type: "usage", stats: null, contextUsage: { tokens: 120, contextWindow: 1000, percent: 12 }, ts: 2 });
		stream.emit({ type: "status", isStreaming: false, ts: 2 });
	});
	expect(await screen.findByRole("button", { name: "12.00% 上下文估算" })).toBeTruthy();
	// 同一会话的用量暂时未知仍保留入口，不能把未知当成 0%。
	await act(async () => stream.emit({ type: "usage", stats: null, contextUsage: null, ts: 3 }));
	expect(await screen.findByRole("button", { name: "上下文用量未知" })).toBeTruthy();

	await open("Open empty");
	expect(screen.queryByRole("button", { name: /上下文/ })).toBeNull();
	await open("Open new", [userMessage]);
	expect(screen.getByRole("button", { name: "上下文用量未知" })).toBeTruthy();
});
