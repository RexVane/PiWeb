// @vitest-environment jsdom
/**
 * 提示词面板：分组列出所有来源，点文件行按需读取内容并交给查看器；
 * 工具提示词与组装后的系统提示词不是文件，在面板内就地展开。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PromptPanel } from "@/components/PromptPanel";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const response = (data: unknown) => ({ ok: true, status: 200, json: async () => ({ success: true, data }) });

function setup(overrides: Record<string, unknown> = {}) {
	const list = {
		sources: [
			{ kind: "system", name: "SYSTEM.md", path: "/ws/.pi/SYSTEM.md", origin: { scope: "project" }, bytes: 120 },
			{ kind: "agents", name: "AGENTS.md", path: "/ws/AGENTS.md", origin: { scope: "project" }, bytes: 2048 },
			{ kind: "skill", name: "demo-skill", path: "/home/u/.pi/agent/skills/demo-skill/SKILL.md", origin: { scope: "agent" }, bytes: 300 },
			{ kind: "template", name: "review", path: "/x/node_modules/@scope/pkg/prompts/review.md", origin: { scope: "package", name: "@scope/pkg" }, bytes: 400 },
		],
		assembledSystemPrompt: "你是 pi。",
		tools: [{ name: "read", description: "读取文件", parameters: { type: "object" }, source: "builtin" }],
		sessionReady: true,
		...overrides,
	};
	const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
		if (typeof url === "string" && url.startsWith("/api/prompts?")) return response(list);
		if (url === "/api/prompts" && init?.method === "POST") {
			const body = JSON.parse(String(init.body));
			if (body.action !== "read") throw new Error("unexpected action");
			return response({ content: `内容:${body.filePath}` });
		}
		throw new Error(`unexpected URL ${url}`);
	});
	vi.stubGlobal("fetch", fetchMock);
	const onOpenContent = vi.fn();
	render(<PromptPanel cwd="/ws" sessionId="sess-1" refreshKey="sess-1" onOpenContent={onOpenContent} onClose={vi.fn()} />);
	return { fetchMock, onOpenContent };
}

describe("PromptPanel", () => {
	it("groups every prompt source and shows where it comes from", async () => {
		setup();
		await waitFor(() => expect(screen.getByText("SYSTEM.md")).toBeTruthy());
		// 分组标题
		expect(screen.getByText("系统提示词文件")).toBeTruthy();
		expect(screen.getByText("项目记忆（AGENTS.md）")).toBeTruthy();
		expect(screen.getByText("技能提示词")).toBeTruthy();
		expect(screen.getByText("提示模板")).toBeTruthy();
		// 来源徽标：项目 / 个人 / 包名
		expect(screen.getAllByText("项目").length).toBeGreaterThan(0);
		expect(screen.getByText("个人")).toBeTruthy();
		expect(screen.getByText("包 @scope/pkg")).toBeTruthy();
		// 文件大小一并显示
		expect(screen.getByText("2.0 KB")).toBeTruthy();
	});

	it("reads a file on click and hands it to the viewer", async () => {
		const { onOpenContent } = setup();
		await waitFor(() => expect(screen.getByText("AGENTS.md")).toBeTruthy());
		fireEvent.click(screen.getByText("AGENTS.md"));
		await waitFor(() => expect(onOpenContent).toHaveBeenCalledWith("/ws/AGENTS.md", "内容:/ws/AGENTS.md"));
	});

	it("hands tool prompts and the system prompt to the centered viewer", async () => {
		const { onOpenContent } = setup();
		await waitFor(() => expect(screen.getByText("read")).toBeTruthy());
		fireEvent.click(screen.getByText("read"));
		await waitFor(() => expect(onOpenContent).toHaveBeenCalledWith("tool-read.md", expect.stringContaining("读取文件")));
		// 参数 schema 以 JSON 代码块形式进入查看器内容
		expect(onOpenContent.mock.calls.at(-1)?.[1]).toContain("```json");

		fireEvent.click(screen.getByText("当前生效的系统提示词"));
		await waitFor(() => expect(onOpenContent).toHaveBeenCalledWith("system-prompt.md", "你是 pi。"));
	});

	it("does not render prompt bodies inside the side list", async () => {
		setup();
		await waitFor(() => expect(screen.getByText("read")).toBeTruthy());
		fireEvent.click(screen.getByText("read"));
		// 侧栏只负责"选择查看哪个"，正文交给居中查看器
		expect(screen.queryByText("你是 pi。")).toBeNull();
		expect(document.querySelector("pre.pw-output")).toBeNull();
	});

	it("explains missing synthesized entries while the session is cold", async () => {
		setup({ sessionReady: false, assembledSystemPrompt: undefined, tools: undefined });
		await waitFor(() => expect(screen.getByText(/会话尚未启动/)).toBeTruthy());
		expect(screen.queryByText("read")).toBeNull();
	});
});
