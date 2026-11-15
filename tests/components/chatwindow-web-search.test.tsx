// @vitest-environment jsdom
/**
 * 联网工具步骤显示与交互测试：
 * - 搜索/抓取步骤使用地球仪图标与「已搜索网络 为 “...”」文案，与本地搜索区分
 * - 展示站点图标堆叠与精确来源数，点击展开可点击打开的外部网站列表
 * - 连续搜索折成汇总行与合计去重来源数；已完成回合折叠后仍保留可点击来源入口
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ChatWindow } from "@/components/ChatWindow";
import type { ToolCardState } from "@/hooks/usePiWeb";
import type { WebMessage } from "@/lib/types";

afterEach(cleanup);

const text = (value: string) => [{ type: "text" as const, text: value }];
const userMsg = (id: string, value: string): WebMessage => ({ role: "user", id, content: text(value), timestamp: 1 });
const finalMsg = (id: string, value: string): WebMessage => ({
	role: "assistant",
	id,
	content: text(value),
	stopReason: "stop",
	timestamp: 10,
	endedAt: 12,
});

describe("web search & fetch steps in ChatWindow", () => {
	it("shows globe indicator, query, favicons, source count, and clickable links for a single web search", () => {
		const call: WebMessage = {
			role: "assistant",
			id: "a1",
			content: [{ type: "toolCall", id: "w1", name: "mcp__tavily__tavily_search", arguments: { query: "piweb GitHub AI agent" } }],
			stopReason: "toolUse",
			timestamp: 2,
		};
		const result = JSON.stringify({
			results: [
				{ title: "PiWeb Repository", url: "https://github.com/example/piweb" },
				{ title: "Tavily Docs", url: "https://docs.tavily.com/welcome" },
			],
		});
		const tools: Record<string, ToolCardState> = {
			w1: { name: "mcp__tavily__tavily_search", args: { query: "piweb GitHub AI agent" }, state: "done", result },
		};
		const { container } = render(<ChatWindow messages={[userMsg("u1", "搜一下"), call]} tools={tools} isStreaming />);

		const step = container.querySelector('.pw-step[data-kind="web_search"]');
		expect(step).toBeTruthy();
		expect(step?.textContent).toContain("已搜索网络");
		expect(step?.textContent).toContain("“piweb GitHub AI agent”");
		expect(container.querySelectorAll(".pw-favicon").length).toBeGreaterThanOrEqual(2);

		const trigger = screen.getByRole("button", { name: /2 个来源/ });
		expect(trigger.getAttribute("aria-expanded")).toBe("false");
		fireEvent.click(trigger);
		expect(trigger.getAttribute("aria-expanded")).toBe("true");

		const githubLink = screen.getByRole("link", { name: /PiWeb Repository/ });
		expect(githubLink.getAttribute("href")).toBe("https://github.com/example/piweb");
		expect(githubLink.getAttribute("target")).toBe("_blank");
		expect(githubLink.getAttribute("rel")).toBe("noopener noreferrer");

		const tavilyLink = screen.getByRole("link", { name: /Tavily Docs/ });
		expect(tavilyLink.getAttribute("href")).toBe("https://docs.tavily.com/welcome");
	});

	it("renders web_fetch with a directly clickable target link and fetched indicator", () => {
		const call: WebMessage = {
			role: "assistant",
			id: "a1",
			content: [{ type: "toolCall", id: "f1", name: "web_fetch", arguments: { url: "https://github.com/example/piweb/blob/main/README.md" } }],
			stopReason: "toolUse",
			timestamp: 2,
		};
		const tools: Record<string, ToolCardState> = {
			f1: { name: "web_fetch", args: { url: "https://github.com/example/piweb/blob/main/README.md" }, state: "done", result: "README contents" },
		};
		const { container } = render(<ChatWindow messages={[userMsg("u1", "打开这个网页"), call]} tools={tools} isStreaming />);

		const step = container.querySelector('.pw-step[data-kind="web_fetch"]');
		expect(step).toBeTruthy();
		expect(step?.textContent).toContain("已访问网页");
		const directLink = screen.getByRole("link", { name: "github.com/example/piweb/blob/main/README.md" });
		expect(directLink.getAttribute("href")).toBe("https://github.com/example/piweb/blob/main/README.md");
		expect(directLink.getAttribute("target")).toBe("_blank");
	});

	it("keeps local grep searches separate from network searches", () => {
		const call: WebMessage = {
			role: "assistant",
			id: "a1",
			content: [
				{ type: "toolCall", id: "g1", name: "grep", arguments: { pattern: "toolKind", path: "src" } },
				{ type: "toolCall", id: "t1", name: "tool_search", arguments: { query: "search" } },
			],
			stopReason: "toolUse",
			timestamp: 2,
		};
		const tools: Record<string, ToolCardState> = {
			g1: { name: "grep", args: { pattern: "toolKind", path: "src" }, state: "done", result: "src/lib/process-format.ts:9" },
			t1: { name: "tool_search", args: { query: "search" }, state: "done", result: "matched grep" },
		};
		const { container } = render(<ChatWindow messages={[userMsg("u1", "查代码"), call]} tools={tools} isStreaming />);

		expect(container.querySelector('.pw-step[data-kind="web_search"]')).toBeNull();
		expect(container.querySelector('.pw-step[data-kind="search"]')?.textContent).toContain("已搜索");
		expect(screen.queryByRole("button", { name: /个来源/ })).toBeNull();
	});

	it("groups consecutive web searches with deduplicated total source count and keeps sources clickable after turn completion", () => {
		const calls: WebMessage = {
			role: "assistant",
			id: "a1",
			content: [
				{ type: "toolCall", id: "s1", name: "web_search", arguments: { query: "piweb" } },
				{ type: "toolCall", id: "s2", name: "web_search", arguments: { query: "pi-web agent" } },
			],
			stopReason: "toolUse",
			timestamp: 2,
			endedAt: 4,
		};
		const tools: Record<string, ToolCardState> = {
			s1: {
				name: "web_search",
				args: { query: "piweb" },
				state: "done",
				result: JSON.stringify([
					{ title: "Repo One", url: "https://github.com/a/piweb" },
					{ title: "Site Two", url: "https://exa.ai/piweb" },
				]),
			},
			s2: {
				name: "web_search",
				args: { query: "pi-web agent" },
				state: "done",
				result: JSON.stringify([
					{ title: "Repo One", url: "https://github.com/a/piweb" },
					{ title: "Brave Blog", url: "https://brave.com/piweb" },
				]),
			},
		};
		const { container } = render(
			<ChatWindow messages={[userMsg("u1", "搜搜 piweb"), calls, finalMsg("a2", "帮你搜到了三个结果。")]} tools={tools} isStreaming={false} />,
		);

		// 回合已折叠时，顶部栏依然可见联网标志与去重总数「3 个来源」，点击即可打开外链
		const collapsedTrigger = screen.getByRole("button", { name: /3 个来源/ });
		fireEvent.click(collapsedTrigger);
		expect(screen.getByRole("link", { name: /Repo One/ }).getAttribute("href")).toBe("https://github.com/a/piweb");
		expect(screen.getByRole("link", { name: /Brave Blog/ }).getAttribute("href")).toBe("https://brave.com/piweb");

		// 点开过程详情后，折叠分组展示「已搜索网络 + 3 个来源」，继续点开可见每条具体搜索词
		fireEvent.click(screen.getByRole("button", { name: /用时/ }));
		const runSummaryBtn = container.querySelector(".pw-summary")!;
		expect(runSummaryBtn.textContent).toContain("已搜索网络");
		fireEvent.click(runSummaryBtn);
		expect(container.textContent).toContain("“piweb”");
		expect(container.textContent).toContain("“pi-web agent”");
	});

	it("surfaces nested codemode web search steps and their returned links", () => {
		const call: WebMessage = {
			role: "assistant",
			id: "a1",
			content: [{ type: "toolCall", id: "cm1", name: "codemode", arguments: { script: "await tools.tavily_search(...)" } }],
			stopReason: "toolUse",
			timestamp: 2,
		};
		const tools: Record<string, ToolCardState> = {
			cm1: {
				name: "codemode",
				args: { script: "await tools.tavily_search(...)" },
				state: "done",
				result: JSON.stringify([{ title: "Nested Hit", url: "https://github.com/nested/piweb" }]),
				children: ["cm1/1"],
			},
			"cm1/1": {
				name: "tavily_search",
				args: { query: "nested piweb" },
				state: "done",
				parentId: "cm1",
			},
		};
		const { container } = render(<ChatWindow messages={[userMsg("u1", "查一下"), call]} tools={tools} isStreaming />);

		const nestedStep = container.querySelector('.pw-nested .pw-step[data-kind="web_search"]');
		expect(nestedStep).toBeTruthy();
		expect(nestedStep?.textContent).toContain("“nested piweb”");

		const trigger = screen.getByRole("button", { name: /1 个来源/ });
		fireEvent.click(trigger);
		expect(screen.getByRole("link", { name: /Nested Hit/ }).getAttribute("href")).toBe("https://github.com/nested/piweb");
	});
});
