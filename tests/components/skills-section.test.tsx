// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SkillsSection } from "@/components/settings/SkillsSection";

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

const SKILLS = [
	{
		name: "git-workflow",
		description: "Branch and PR workflow conventions",
		filePath: "/home/user/.agents/skills/git-workflow/SKILL.md",
		scope: "user" as const,
		origin: "top-level" as const,
		sourceLabel: "~/.agents/skills",
		baseDir: "/home/user/.agents/skills/git-workflow",
		disabled: false,
	},
	{
		name: "db-migrate",
		description: "Safe SQLite and Postgres schema migration steps",
		filePath: "/ws/.pi/skills/db-migrate/SKILL.md",
		scope: "project" as const,
		origin: "top-level" as const,
		sourceLabel: ".pi/skills",
		baseDir: "/ws/.pi/skills/db-migrate",
		disabled: true,
	},
	{
		name: "mcp-browser",
		description: "Package skill for browser automation",
		filePath: "/home/user/.pi/agent/npm/node_modules/pkg/skills/mcp-browser/SKILL.md",
		scope: "user" as const,
		origin: "package" as const,
		sourceLabel: "npm:pkg",
		baseDir: "/home/user/.pi/agent/npm/node_modules/pkg",
		disabled: false,
	},
];

describe("SkillsSection", () => {
	it("shows the workspace selector only on the project tab", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(JSON.stringify({ success: true, data: { skills: SKILLS } }), { status: 200 })),
		);
		render(
			<SkillsSection
				cwd="/ws"
				hideDesc
				workspaceOptions={[{ value: "/ws", label: "PiWeb" }, { value: "/other", label: "Other" }]}
				onCwdChange={() => {}}
			/>,
		);
		await screen.findByText("git-workflow");
		// 个人 / 全部页签不需要工作区
		expect(screen.queryByText("当前工作区")).toBeNull();
		fireEvent.click(screen.getByRole("tab", { name: /项目/ }));
		expect(screen.getByText("当前工作区")).toBeTruthy();
	});

	it("filters by scope pills and search, shows /skill commands, and toggles skills", async () => {
		const posts: Record<string, unknown>[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
				if (init?.method === "POST") {
					posts.push(JSON.parse(String(init.body)));
					return new Response(JSON.stringify({ success: true, data: { content: "# Skill doc" } }), { status: 200 });
				}
				return new Response(JSON.stringify({ success: true, data: { skills: SKILLS } }), { status: 200 });
			}),
		);

		const onOpenFileContent = vi.fn();
		render(<SkillsSection cwd="/ws" hideDesc onOpenFileContent={onOpenFileContent} />);

		await screen.findByText("git-workflow");
		expect(screen.getByText("/skill:git-workflow")).toBeTruthy();
		expect(screen.getByText("/skill:db-migrate")).toBeTruthy();
		expect(screen.getByText("已关闭")).toBeTruthy();

		// Scope filter pill: only personal / project remain (包 is an origin badge, not a scope)
		expect(screen.getByRole("tab", { name: /个人/ })).toBeTruthy();
		fireEvent.click(screen.getByRole("tab", { name: /项目/ }));
		expect(screen.getByText("db-migrate")).toBeTruthy();
		expect(screen.queryByText("git-workflow")).toBeNull();

		// Back to all + search
		fireEvent.click(screen.getByRole("tab", { name: /全部/ }));
		fireEvent.change(screen.getByRole("searchbox"), { target: { value: "browser" } });
		expect(screen.getByText("mcp-browser")).toBeTruthy();
		expect(screen.getByText("包")).toBeTruthy();
		expect(screen.queryByText("git-workflow")).toBeNull();

		// Open SKILL.md
		fireEvent.click(screen.getByRole("button", { name: "查看 SKILL.md" }));
		await waitFor(() =>
			expect(onOpenFileContent).toHaveBeenCalledWith(
				"/home/user/.pi/agent/npm/node_modules/pkg/skills/mcp-browser/SKILL.md",
				"# Skill doc",
			),
		);

		// Toggle skill
		fireEvent.click(screen.getByRole("switch", { name: "mcp-browser" }));
		await waitFor(() =>
			expect(posts.some((p) => p.action === "toggle" && p.disabled === true)).toBe(true),
		);
	});

	it("keeps scope tabs and workspace selector accessible inline when the active workspace has zero skills", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(JSON.stringify({ success: true, data: { skills: [] } }), { status: 200 })),
		);
		const onCwdChange = vi.fn();
		render(
			<SkillsSection
				cwd="/empty-ws"
				hideDesc
				workspaceOptions={[{ value: "/empty-ws", label: "Empty" }, { value: "/ws", label: "PiWeb" }]}
				onCwdChange={onCwdChange}
			/>,
		);
		await screen.findByText("暂无已安装技能");
		const projectTab = screen.getByRole("tab", { name: /项目/ });
		fireEvent.click(projectTab);
		const wsButton = screen.getByRole("button", { name: "当前工作区" });
		expect(projectTab.closest('[role="tablist"]')?.parentElement?.contains(wsButton)).toBe(true);
		fireEvent.click(wsButton);
		fireEvent.click(await screen.findByRole("option", { name: "PiWeb" }));
		expect(onCwdChange).toHaveBeenCalledWith("/ws");
	});
});
