// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { PluginsSection } from "@/components/settings/PluginsSection";
import { MarketWorkspaceView, PromptsWorkspaceView } from "@/components/workspace/SkillsPluginsViews";

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe("PromptsWorkspaceView", () => {
	it("localizes kinds/origins, filters via tabs & search, and opens file prompts", async () => {
		const onOpenFileContent = vi.fn();

		const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url.startsWith("/api/prompts") && init?.method === "POST") {
				return {
					ok: true,
					json: async () => ({ success: true, data: { content: "# Agent Rules\nBe concise." } }),
				};
			}
			if (url.startsWith("/api/prompts")) {
				return {
					ok: true,
					json: async () => ({
						success: true,
						data: {
							sources: [
								{ kind: "agents", name: "AGENTS.md", path: "/ws/AGENTS.md", origin: { scope: "project" }, bytes: 1536 },
								{ kind: "skill", name: "deploy.md", path: "/home/.pi/agent/skills/deploy.md", origin: { scope: "agent" }, bytes: 420 },
								{ kind: "system", name: "inline-fragment", origin: { scope: "package", name: "my-pkg" } },
							],
						},
					}),
				};
			}
			return {
				ok: true,
				json: async () => ({ success: true, data: { themes: [] } }),
			};
		});
		vi.stubGlobal("fetch", fetchMock);

		render(
			<PromptsWorkspaceView
				knownCwds={["/ws"]}
				defaultCwd="/ws"
				getWorkspaceName={() => "PiWeb"}
				onOpenFileContent={onOpenFileContent}
			/>,
		);

		await screen.findByText("AGENTS.md");
		expect(screen.getByText("项目记忆（AGENTS.md）")).toBeTruthy();
		expect(screen.getByText("技能提示词")).toBeTruthy();
		expect(screen.getByText("系统提示词文件")).toBeTruthy();
		expect(screen.getByText("1.5 KB")).toBeTruthy();
		expect(screen.getByText("包: my-pkg")).toBeTruthy();

		// Item without path must not render as an interactive button
		expect(screen.queryByRole("button", { name: /inline-fragment/ })).toBeNull();

		// Clicking a file-backed prompt reads content and opens viewer
		fireEvent.click(screen.getByRole("button", { name: /AGENTS\.md/ }));
		await waitFor(() => expect(onOpenFileContent).toHaveBeenCalledWith("/ws/AGENTS.md", "# Agent Rules\nBe concise."));

		// Filter tab switches to Skills only
		fireEvent.click(screen.getByRole("tab", { name: /技能/ }));
		expect(screen.getByText("deploy.md")).toBeTruthy();
		expect(screen.queryByText("AGENTS.md")).toBeNull();

		// Search resets back on All
		fireEvent.click(screen.getByRole("tab", { name: /全部/ }));
		fireEvent.change(screen.getByPlaceholderText("搜索提示词名称、来源或路径"), { target: { value: "AGENTS" } });
		expect(screen.getByText("AGENTS.md")).toBeTruthy();
		expect(screen.queryByText("deploy.md")).toBeNull();
	});
});

describe("MarketWorkspaceView", () => {
	it("supports project/user install scope, surfaces install errors in toast, syncs initialCategory, and unified refresh reloads market", async () => {
		let failInstall = true;
		const postBodies: Array<Record<string, unknown>> = [];
		const marketUrls: string[] = [];

		const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url.startsWith("/api/plugins/marketplace") && init?.method === "POST") {
				return {
					ok: true,
					json: async () => ({
						success: true,
						data: {
							compatibility: {
								"pi-theme-pack": {
									status: "compatible",
									resources: { extensions: false, skills: false, prompts: false, themes: true },
									hasPiManifest: true,
									hasDshConfig: false,
									hasTuiPeer: false,
									blockers: [],
									caveats: [{ kind: "themes_ignored" }],
								},
							},
						},
					}),
				};
			}
			if (url.startsWith("/api/plugins/marketplace")) {
				marketUrls.push(url);
				return {
					ok: true,
					json: async () => ({
						total: 1,
						items: [
							{
								name: "pi-theme-pack",
								source: "npm:pi-theme-pack",
								version: "1.2.0",
								description: "Terminal palette pack",
								author: "alice",
								keywords: ["theme"],
								updatedAt: "",
								monthlyDownloads: 300,
							},
						],
					}),
				};
			}
			if (url === "/api/plugins" && init?.method === "POST") {
				const body = JSON.parse(String(init.body)) as Record<string, unknown>;
				postBodies.push(body);
				if (failInstall) {
					return { ok: false, status: 500, json: async () => ({ success: false, error: "npm E404" }) };
				}
				return { ok: true, json: async () => ({ success: true, data: {} }) };
			}
			return { ok: true, json: async () => ({ success: true, data: { packages: [] } }) };
		});
		vi.stubGlobal("fetch", fetchMock);

		render(
			<MarketWorkspaceView
				knownCwds={["/ws"]}
				defaultCwd="/ws"
				getWorkspaceName={() => "PiWeb"}
				initialCategory="theme"
			/>,
		);

		await screen.findByText("pi-theme-pack");
		expect(marketUrls.some((u) => u.includes("category=theme"))).toBe(true);
		expect(screen.getByRole("button", { name: "主题与外观" }).getAttribute("aria-pressed")).toBe("true");
		// Compatibility theme resource badge rendered cleanly without broken mid-line bullets
		await screen.findByText("主题");

		// Failed install shows explicit error toast instead of swallowing failure silently
		fireEvent.click(screen.getByRole("button", { name: "安装" }));
		await screen.findByText(/插件会在运行时执行代码/);
		fireEvent.click(screen.getAllByRole("button", { name: "安装" }).at(-1)!);
		await screen.findByText("npm E404");
		expect(postBodies[0]).toMatchObject({ action: "install", source: "npm:pi-theme-pack", local: false, cwd: "/ws" });

		// 装到个人全局不需要工作区；切到当前项目才出现工作区选择器
		expect(screen.queryByRole("button", { name: "当前工作区" })).toBeNull();
		failInstall = false;
		fireEvent.click(screen.getByRole("button", { name: "当前项目" }));
		expect(screen.getByRole("button", { name: "当前工作区" })).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "安装" }));
		await screen.findByText(/插件会在运行时执行代码/);
		fireEvent.click(screen.getAllByRole("button", { name: "安装" }).at(-1)!);
		await screen.findByText("已安装并加载");
		expect(postBodies[1]).toMatchObject({ action: "install", source: "npm:pi-theme-pack", local: true, cwd: "/ws" });

		// Header refresh triggers fresh marketplace fetch with refresh=1
		fireEvent.click(screen.getByRole("button", { name: "刷新" }));
		await waitFor(() => expect(marketUrls.some((u) => u.includes("refresh=1"))).toBe(true));
	});

	it("preserves marketplace search input and sub-tab when switching workspace under project scope", async () => {
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.startsWith("/api/plugins/marketplace")) {
				return {
					ok: true,
					json: async () => ({ total: 0, items: [] }),
				};
			}
			return { ok: true, json: async () => ({ success: true, data: { packages: [] } }) };
		});
		vi.stubGlobal("fetch", fetchMock);

		render(
			<MarketWorkspaceView
				knownCwds={["/ws", "/other"]}
				defaultCwd="/ws"
				getWorkspaceName={(cwd) => (cwd === "/ws" ? "PiWeb" : "Other")}
				initialCategory="all"
			/>,
		);

		const searchBox = await screen.findByPlaceholderText("搜索扩展、MCP 或 npm 包…");
		fireEvent.change(searchBox, { target: { value: "theme" } });
		fireEvent.click(screen.getByRole("tab", { name: /未安装/ }));
		fireEvent.click(screen.getByRole("button", { name: "当前项目" }));

		const wsTrigger = screen.getByRole("button", { name: "当前工作区" });
		fireEvent.click(wsTrigger);
		fireEvent.click(await screen.findByRole("option", { name: "Other" }));

		await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("cwd=%2Fother"), expect.anything()));
		expect((screen.getByPlaceholderText("搜索扩展、MCP 或 npm 包…") as HTMLInputElement).value).toBe("theme");
		expect(screen.getByRole("tab", { name: /未安装/ }).getAttribute("aria-selected")).toBe("true");
	});
});

describe("PluginsSection polish", () => {
	it("does not mislabel built-ins with personal scope and renders empty-state market CTA when only built-ins exist", async () => {
		const onOpenMarket = vi.fn();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				ok: true,
				json: async () => ({
					success: true,
					data: {
						packages: [],
						extensions: [
							{ name: "codemode", path: "builtin:codemode", disabled: false, origin: "builtin", scope: "user" },
						],
					},
				}),
			})),
		);

		render(<PluginsSection cwd="/ws" hideHeader onOpenMarket={onOpenMarket} />);

		await screen.findByText("Codemode");
		const personalTab = screen.getByRole("tab", { name: /个人/ });
		expect(within(personalTab).getByText("0")).toBeTruthy();

		// Built-in row renders 内置 badge without redundant 个人 badge
		const codemodeRow = screen.getByText("Codemode").closest("div")?.parentElement?.parentElement;
		expect(codemodeRow).toBeTruthy();
		if (codemodeRow) {
			expect(within(codemodeRow).getByText("内置")).toBeTruthy();
			expect(within(codemodeRow).queryByText("个人")).toBeNull();
		}

		// Empty card below built-ins shows CTA to browse marketplace
		fireEvent.click(screen.getByRole("button", { name: "浏览资源市场" }));
		expect(onOpenMarket).toHaveBeenCalledTimes(1);
	});
});
