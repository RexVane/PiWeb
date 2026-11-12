// @vitest-environment jsdom
/**
 * Composer 隔离：流式 token 只更新消息时，AppShell 会重渲染，但输入区不能跟着重渲染。
 *
 * 这里用一个计数的 ChatInput 替身 + 可控的 usePiWeb 消息数组：
 * 推送一条新消息后，ChatInput 的渲染次数必须保持不变。ContextMeter 的完整消息
 * 不进入 props（改为打开时惰性读取），所以 messages 变化不会击穿 memo。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useState } from "react";
import { AppShell } from "@/components/AppShell";
import type { WebMessage } from "@/lib/types";

const counters = vi.hoisted(() => ({
	chatInputRenders: 0,
	pushMessages: null as null | ((update: (messages: WebMessage[]) => WebMessage[]) => void),
	lastProps: null as null | Record<string, unknown>,
	diff: [] as string[],
}));

const model = { id: "test-model", name: "Test", provider: "test", reasoning: false, contextWindow: 1000, thinkingLevels: [] };
const messages: WebMessage[] = [
	{ role: "user", id: "u1", content: [{ type: "text", text: "你好" }], timestamp: 1 },
	{ role: "assistant", id: "a1", content: [{ type: "text", text: "在" }], stopReason: "pending", timestamp: 2 },
];
const sessions = [{ path: "/session-a", cwd: "/workspace", name: "session-a" }];
const models = { models: [model], providers: [{ id: "test", name: "Test", authReady: true }] };
const tools = {};
const growth = { rounds: [], error: null, consent: null };
const breakdown = { systemPrompt: 0, systemTools: 0, customTools: 0, memory: 0, skills: 0, compacted: 0, autoCompactBuffer: 0, cold: false, characters: { systemPrompt: 0, systemTools: 0, customTools: 0, memory: 0, skills: 0, compacted: 0 } };
const snapshot = {
	cwd: "/workspace",
	sessionPath: "/session-a",
	name: "session-a",
	model,
	routedModel: null,
	thinkingLevel: "off",
	thinkingLevels: ["off", "low"],
	trajectory: [],
	messages,
	userTurns: [],
	queue: { steering: [], followUp: [] },
	isStreaming: true,
	contextUsage: { percent: 10, tokens: 100, contextWindow: 1000 },
	contextBreakdown: breakdown,
	contextResources: [],
	contextFiles: [],
	stats: { assistantMessages: 1, userMessages: 1, toolCalls: 0, totalMessages: 2, tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 }, cost: 0, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0, llmTimedSteps: 0, toolTimedCalls: 0, decodeSteps: 0 },
};

const noop = () => {};
// usePiWeb 的真实回调都是 useCallback；mock 也必须在多次渲染间保持同一引用，
// 否则测到的是 mock 抖动，不是 Composer 隔离。
const sendCommand = vi.fn(async () => ({ success: true }));
vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("@/lib/theme", () => ({ syncPebrelTheme: () => {} }));
vi.mock("@/hooks/useGrowth", () => ({
	useGrowth: () => ({
		available: false, loading: false, error: null, rounds: [], selected: null, scope: "session", range: undefined,
		changes: [], changesReady: false, tree: null, filePaths: [], expanded: new Set<string>(), fresh: false,
		selectLatest: noop, select: noop, prev: noop, next: noop, setScope: noop, toggleDir: noop, revealPath: noop,
		expandAll: noop, collapseAll: noop, expandLazy: noop, refresh: noop, recordNow: noop,
	}),
}));
vi.mock("@/components/SessionSidebar", () => ({ SessionSidebar: () => null }));
vi.mock("@/components/ExtensionUI", () => ({
	ExtensionDialogHost: () => null,
	ExtensionNotices: ({ children }: { children?: React.ReactNode }) => children ?? null,
	ExtensionWidgets: () => null,
}));
vi.mock("@/components/ChatInput", () => ({
	ChatInput: (props: Record<string, unknown>) => {
		counters.chatInputRenders += 1;
		if (counters.lastProps) {
			counters.diff = Object.keys(props).filter((key) => props[key] !== counters.lastProps![key]);
		}
		counters.lastProps = props;
		return null;
	},
	EMPTY_CHAT_DRAFT: { text: "", images: [], uploads: [], references: [] },
}));
vi.mock("@/hooks/usePiWeb", () => ({
	usePiWeb: () => {
		const [currentMessages, setMessages] = useState(messages);
		counters.pushMessages = setMessages;
		return {
			sessions,
			archivedSessions: [], archivedSessionPaths: [], addedWorkspaces: ["/workspace"], removedWorkspaces: [], workspaceAliases: {},
			pinnedSessionPaths: [],
			currentPath: "/session-a",
			currentId: "current-id",
			models,
			state: {
				snapshot,
				messages: currentMessages,
				tools,
				toolPreset: "standard",
				connected: true,
				error: null,
				compaction: null,
				retryNotice: null,
				extensionDialogs: [],
				extensionNotices: [],
				extensionStatuses: {},
				extensionWidgets: {},
				extensionTitle: null,
				editorText: null,
				workingMessage: null,
				growth,
			},
			getWorkspaceName: (cwd: string) => cwd,
			sendCommand,
			newSession: async () => null,
			openSession: noop,
			closeSession: noop,
			resync: noop,
			groupBy: "workspace",
			orderBy: "updated",
			setGroupBy: noop,
			setOrderBy: noop,
			addWorkspaceByPicker: noop,
			dirPickerOpen: false,
			confirmDirPicker: noop,
			cancelDirPicker: noop,
			removeWorkspace: noop,
			refreshModels: noop,
			setToolPreset: noop,
			toolPresetChanging: false,
			clearError: noop,
			clearCompaction: noop,
			setError: noop,
			answerExtensionDialog: noop,
			answerGrowthConsent: noop,
			dismissExtensionNotice: noop,
			renameWorkspace: noop,
			patchSessionName: noop,
			archiveSession: noop,
			unarchiveSession: noop,
			pinSession: noop,
			unpinSession: noop,
			deleteSession: noop,
		};
	},
}));

afterEach(cleanup);

describe("Composer isolation", () => {
	it("does not re-render the composer when only streaming messages change", () => {
		render(<AppShell />);
		const before = counters.chatInputRenders;
		expect(before).toBeGreaterThan(0);
		expect(counters.pushMessages).not.toBeNull();

		act(() => {
			counters.pushMessages!((current) => [
				...current,
				{ role: "assistant", id: "a2", content: [{ type: "text", text: "新的 token" }], stopReason: "pending", timestamp: 3 },
			]);
		});

		expect(counters.chatInputRenders, `changed props: ${counters.diff.join(", ") || "none"}`).toBe(before);
	});
});
