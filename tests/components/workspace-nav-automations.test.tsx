// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { AutomationsWorkspaceView } from "@/components/workspace/AutomationsWorkspaceView";
import { SessionSidebar } from "@/components/SessionSidebar";
import { SettingsPanel } from "@/components/SettingsPanel";
import type { AutomationRun, AutomationTask } from "@/lib/automations/types";

vi.mock("@/lib/theme", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/theme")>()),
	applyPebrelTheme: () => {},
	loadPebrelTheme: () => "dsh",
	loadThemeMode: () => "system",
}));

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe("Top-level sidebar nav and Settings slimming", () => {
	it("orders 扩展, 自动化任务 top-to-bottom between 新会话 and 工作区 without 技能 or 提示词", () => {
		const onSelectView = vi.fn();
		const { container } = render(
			<SessionSidebar
				sessions={[
					{
						path: "/sessions/a.jsonl",
						cwd: "/ws",
						name: "Session A",
						modified: new Date().toISOString(),
						created: new Date().toISOString(),
						messageCount: 1,
						firstMessage: "Session A",
						streaming: false,
					},
				]}
				addedWorkspaces={["/ws"]}
				currentPath="/sessions/a.jsonl"
				groupBy="workspace"
				orderBy="updated"
				setGroupBy={vi.fn()}
				setOrderBy={vi.fn()}
				collapsed={false}
				onToggleCollapse={vi.fn()}
				onOpen={vi.fn()}
				onNew={vi.fn()}
				onNewInWorkspace={vi.fn()}
				onRename={vi.fn(async () => {})}
				onOpenSettings={vi.fn()}
				onAddWorkspace={vi.fn()}
				activeView="automations"
				onSelectView={onSelectView}
			/>,
		);

		const text = container.textContent ?? "";
		const idxNew = text.indexOf("新会话");
		const idxPlugins = text.search(/插件|扩展/);
		const idxAuto = text.indexOf("自动化任务");
		const idxWs = text.indexOf("工作区");

		expect(idxNew).toBeGreaterThanOrEqual(0);
		expect(screen.queryByRole("button", { name: "技能" })).toBeNull();
		expect(screen.queryByRole("button", { name: "提示词" })).toBeNull();
		// 资源市场已从产品里移除
		expect(screen.queryByRole("button", { name: "资源市场" })).toBeNull();
		expect(idxPlugins).toBeGreaterThan(idxNew);
		expect(idxAuto).toBeGreaterThan(idxPlugins);
		expect(idxWs).toBeGreaterThan(idxAuto);

		expect(screen.getByRole("button", { name: "自动化任务" }).getAttribute("data-active")).toBe("true");
		// While a top-level tool view is active, the session row is not highlighted simultaneously
		const sessionRow = screen.getByText("Session A").closest('[class*="isx-menu-item"]');
		expect(sessionRow?.getAttribute("data-active")).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: /^(?:插件|扩展)$/ }));
		expect(onSelectView).toHaveBeenNthCalledWith(1, "plugins");
	});

	it("omits 技能 and 插件 tabs from SettingsPanel", () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				ok: true,
				status: 200,
				json: async () => ({
					success: true,
					data: {
						retry: { enabled: true, maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 10000 },
						compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
					},
				}),
			})),
		);
		render(<SettingsPanel open onClose={vi.fn()} />);

		expect(screen.getByRole("button", { name: "通用设置" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "模型" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "远程连接" })).toBeTruthy();
		expect(screen.queryByRole("button", { name: "技能" })).toBeNull();
		expect(screen.queryByRole("button", { name: /^(?:插件|扩展)$/ })).toBeNull();
	});
});

describe("AutomationsWorkspaceView", () => {
	it("creates tasks, triggers runNow, and navigates to the generated session", async () => {
		const posts: any[] = [];
		const state: { tasks: AutomationTask[]; runs: AutomationRun[]; activeTaskIds: string[] } = {
			tasks: [
				{
					id: "task-1",
					name: "Nightly Audit",
					prompt: "Inspect repo",
					cwd: "/ws",
					schedule: { kind: "daily" as const, time: "09:00" },
					enabled: true,
					createdAt: 1000,
					updatedAt: 1000,
					nextRunAt: Date.now() + 60_000,
					lastRunAt: Date.now() - 60_000,
					lastRunStatus: "success" as const,
					lastSessionPath: "/sessions/auto-1.jsonl",
				},
			],
			runs: [
				{
					id: "run-1",
					taskId: "task-1",
					taskName: "Nightly Audit",
					cwd: "/ws",
					trigger: "schedule" as const,
					status: "success" as const,
					startedAt: Date.now() - 60_000,
					finishedAt: Date.now() - 50_000,
					sessionPath: "/sessions/auto-1.jsonl",
					summary: "All tests green.",
				},
			],
			activeTaskIds: [] as string[],
		};

		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
				if (init?.method === "POST") {
					const body = JSON.parse(String(init.body));
					posts.push(body);
					if (body.action === "create") {
						state.tasks = [
							{
								id: "task-2",
								name: body.name,
								prompt: body.prompt,
								cwd: body.cwd,
								schedule: body.schedule,
								enabled: true,
								createdAt: Date.now(),
								updatedAt: Date.now(),
								nextRunAt: Date.now() + 600_000,
							},
							...state.tasks,
						];
					}
					return { ok: true, status: 200, json: async () => ({ success: true, data: {} }) };
				}
				return {
					ok: true,
					status: 200,
					json: async () => ({
						success: true,
						data: {
							defaultCwd: "/agent/automations",
							...state,
							tasks: [...state.tasks],
							runs: [...state.runs],
						},
					}),
				};
			}),
		);

		const onOpenSession = vi.fn();
		const onCreateInSession = vi.fn();
		render(
			<AutomationsWorkspaceView
				knownCwds={["/ws"]}
				defaultCwd="/ws"
				getWorkspaceName={() => "Demo WS"}
				models={[{ provider: "openai", id: "gpt-5", name: "GPT-5" }]}
				onOpenSession={onOpenSession}
				onCreateInSession={onCreateInSession}
			/>,
		);

		await screen.findByText("Nightly Audit");
		expect(screen.queryByText("当前工作区")).toBeNull();
		expect(screen.getByRole("tab", { name: /已开启/ })).toBeTruthy();
		expect(screen.getByRole("tab", { name: /已暂停/ })).toBeTruthy();
		expect(screen.getByRole("tab", { name: /已结束/ })).toBeTruthy();
		expect(screen.getByRole("tab", { name: /全部/ })).toBeTruthy();

		// Clicking primary "+ 新建" jumps to in-session Hero creation with independent dir
		fireEvent.click(screen.getByRole("button", { name: "新建" }));
		expect(onCreateInSession).toHaveBeenCalledWith("/agent/automations", "请根据需求创建一个自动化任务。");

		fireEvent.click(screen.getByRole("button", { name: "立即运行" }));
		await waitFor(() => expect(posts.some((p) => p.action === "runNow" && p.id === "task-1")).toBe(true));

		// Open split dropdown -> Manual create opens modal with schedule rules & defaults cwd to independent dir
		fireEvent.click(screen.getByRole("button", { name: "新建任务" }));
		fireEvent.click(await screen.findByRole("menuitem", { name: "手动创建" }));
		const dialog = await screen.findByRole("dialog");
		expect(within(dialog).getByText("自动化工作区")).toBeTruthy();
		fireEvent.change(within(dialog).getByPlaceholderText(/每日代码/), { target: { value: "Hourly Ping" } });
		fireEvent.change(within(dialog).getByPlaceholderText(/描述每次触发/), { target: { value: "Say hi" } });
		const dailyTab = within(dialog).getByRole("button", { name: "每天" });
		expect(dailyTab.getAttribute("aria-pressed")).toBe("true");
		fireEvent.click(within(dialog).getByRole("button", { name: "每周" }));
		expect(within(dialog).getByRole("button", { name: "周一" }).getAttribute("aria-pressed")).toBe("true");
		const intervalTab = within(dialog).getByRole("button", { name: "固定间隔" });
		fireEvent.click(intervalTab);
		expect(intervalTab.getAttribute("aria-pressed")).toBe("true");
		fireEvent.click(within(dialog).getByRole("button", { name: "确认" }));

		await waitFor(() => expect(posts.some((p) => p.action === "create" && p.name === "Hourly Ping" && p.cwd === "/agent/automations")).toBe(true));
		await screen.findByText("Hourly Ping");

		// Switch to Runs tab and open generated session
		fireEvent.click(screen.getByRole("tab", { name: /执行记录/ }));
		await screen.findByText("All tests green.");
		fireEvent.click(screen.getByRole("button", { name: "查看会话" }));
		expect(onOpenSession).toHaveBeenCalledWith("/sessions/auto-1.jsonl");
	});
});
