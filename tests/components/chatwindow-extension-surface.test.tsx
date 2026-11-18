// @vitest-environment jsdom
/**
 * 模型看得到、但不属于「用户发言 / 模型回答」的东西在对话里的显示：
 * 扩展注入的消息、用户的 `!` 命令、工具自己发起的嵌套调用。
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ChatWindow } from "@/components/ChatWindow";
import type { ToolCardState } from "@/hooks/usePiWeb";
import type { WebMessage } from "@/lib/types";

afterEach(cleanup);

const text = (value: string) => [{ type: "text" as const, text: value }];
const userMessage = (id: string, value: string): WebMessage => ({ role: "user", id, content: text(value), timestamp: 1 });
const answer = (id: string, value: string): WebMessage => ({ role: "assistant", id, content: text(value), stopReason: "stop", timestamp: 2, endedAt: 3 });

describe("扩展注入的消息", () => {
	it("显示类型名和首行，点开看全文", () => {
		const custom: WebMessage = { role: "custom", id: "c1", customType: "plan-mode", content: text("计划已批准\n\n1. 先改 A\n2. 再改 B"), timestamp: 2 };
		render(<ChatWindow messages={[userMessage("u1", "开始"), custom]} tools={{}} />);
		const line = screen.getByRole("button", { name: /plan-mode/ });
		expect(line.textContent).toContain("计划已批准 1. 先改 A 2. 再改 B");
		expect(line.getAttribute("aria-expanded")).toBe("false");
		fireEvent.click(line);
		expect(line.getAttribute("aria-expanded")).toBe("true");
	});

	it("没有类型名时用通用名称，不留空行", () => {
		render(<ChatWindow messages={[userMessage("u1", "开始"), { role: "custom", id: "c1", content: text("扩展提示"), timestamp: 2 }]} tools={{}} />);
		expect(screen.getByRole("button", { name: /扩展消息/ }).textContent).toContain("扩展提示");
	});
});

describe("用户的 ! 命令", () => {
	const bash = (overrides: Partial<NonNullable<WebMessage["bash"]>> = {}): WebMessage => ({
		role: "bashExecution", id: "b1", streamId: "s1", content: [], timestamp: 5,
		bash: { command: "git status --short", output: " M src/a.ts", exitCode: 0, ...overrides },
	});

	it("回答之后跑的命令排在回答下面，带 ! 标签，不折进「运行了 N 条命令」", () => {
		const { container } = render(<ChatWindow messages={[userMessage("u1", "看看"), answer("a1", "这是回答"), bash()]} tools={{}} />);
		const command = screen.getByText("git status --short");
		expect(screen.getByText("!").className).toContain("pw-badge");
		// 文档顺序：回答在前，命令在后
		const finalAnswer = container.querySelector('[data-role="assistant"]')!;
		expect(finalAnswer.compareDocumentPosition(command) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		expect(container.querySelector(".pw-summary")).toBeNull();
	});

	it("!! 标出结果不进上下文；失败的命令显示成失败", () => {
		const { container } = render(<ChatWindow messages={[bash({ excludeFromContext: true, exitCode: 1, output: "fatal: not a git repository" })]} tools={{}} />);
		expect(screen.getByText("!!").className).toContain("pw-badge");
		expect(container.querySelector('.pw-step[data-tone="fail"]')).toBeTruthy();
		expect(screen.getByText("fatal: not a git repository")).toBeTruthy();
	});

	it("还在跑的命令显示为进行中", () => {
		render(<ChatWindow messages={[bash({ running: true, output: "", exitCode: undefined })]} tools={{}} isStreaming />);
		// 看的是命令自己那一行，不是回合末尾的工作指示
		expect(screen.getByText("git status --short").closest(".pw-step")?.getAttribute("data-live")).toBe("true");
	});

	it("被停止的命令显示成已中止，不算失败也不算正常完成", () => {
		render(<ChatWindow messages={[bash({ command: "npm run dev", cancelled: true, exitCode: undefined, output: "server listening" })]} tools={{}} />);
		const step = screen.getByText("npm run dev").closest(".pw-step")!;
		expect(step.getAttribute("data-tone")).not.toBe("fail");
		expect(step.textContent).toContain("已中止");
		// 停止前已经打出来的输出还在
		expect(step.textContent).toContain("server listening");
	});
});

describe("嵌套调用", () => {
	it("codemode 脚本里发起的调用缩进显示在它下面，包括更深一层的", () => {
		const call: WebMessage = { role: "assistant", id: "a1", content: [{ type: "toolCall", id: "c1", name: "codemode", arguments: { script: "await tools.read(…)" } }], stopReason: "toolUse", timestamp: 2 };
		const tools: Record<string, ToolCardState> = {
			c1: { name: "codemode", args: { script: "await tools.read(…)" }, state: "done", result: "ok", children: ["c1/1", "c1/2"] },
			"c1/1": { name: "read", args: { path: "src/nested-read.ts" }, state: "done", parentId: "c1" },
			"c1/2": { name: "edit", args: { path: "src/nested-edit.ts" }, state: "done", parentId: "c1", children: ["c1/2/1"] },
			"c1/2/1": { name: "read", args: { path: "src/deeper.ts" }, state: "done", parentId: "c1/2" },
		};
		const { container } = render(<ChatWindow messages={[userMessage("u1", "重构"), call]} tools={tools} />);
		const nested = container.querySelectorAll(".pw-nested");
		// 两层：c1 的子调用，以及 c1/2 的子调用
		expect(nested).toHaveLength(2);
		expect(nested[0].textContent).toContain("src/nested-read.ts");
		expect(nested[0].textContent).toContain("src/nested-edit.ts");
		expect(nested[1].textContent).toContain("src/deeper.ts");
		expect(nested[0].contains(nested[1])).toBe(true);
	});

	it("没有嵌套调用的工具行不多出空容器", () => {
		const call: WebMessage = { role: "assistant", id: "a1", content: [{ type: "toolCall", id: "c1", name: "edit", arguments: { path: "src/a.ts" } }], stopReason: "toolUse", timestamp: 2 };
		const { container } = render(<ChatWindow messages={[userMessage("u1", "改"), call]} tools={{ c1: { name: "edit", args: { path: "src/a.ts" }, state: "done" } }} />);
		expect(container.querySelector(".pw-nested")).toBeNull();
	});
});

describe("模型主动读取 SKILL.md 的 [skill] 步骤渲染", () => {
	it("read SKILL.md 渲染成 skill 样式且不折叠进文件读取汇总，保留原文展开与打开文件能力", () => {
		const calls: WebMessage = {
			role: "assistant",
			id: "a1",
			content: [
				{ type: "toolCall", id: "r-skill", name: "read", arguments: { path: "C:\\Users\\demo\\.agents\\skills\\plan-review\\SKILL.md" } },
				{ type: "toolCall", id: "r-file", name: "read", arguments: { path: "src/app.ts" } },
			],
			stopReason: "toolUse",
			timestamp: 2,
		};
		const tools: Record<string, ToolCardState> = {
			"r-skill": {
				name: "read",
				args: { path: "C:\\Users\\demo\\.agents\\skills\\plan-review\\SKILL.md" },
				state: "done",
				result: "# Plan Review\nCheck edges.",
			},
			"r-file": {
				name: "read",
				args: { path: "src/app.ts" },
				state: "done",
				result: "export const app = 1;",
			},
		};
		const { container } = render(
			<ChatWindow
				messages={[userMessage("u1", "检查一下"), calls, answer("a2", "已检查")]}
				tools={tools}
			/>,
		);
		const skillStep = container.querySelector('.pw-step[data-kind="skill"]');
		expect(skillStep).toBeTruthy();
		expect(skillStep?.querySelector(".pw-badge")?.textContent).toBe("skill");
		const skillName = skillStep?.querySelector(".pw-skill-name");
		expect(skillName?.textContent).toBe("plan-review");
		expect(skillName?.getAttribute("title")).toBe("C:/Users/demo/.agents/skills/plan-review/SKILL.md");

		// 普通 read 被折进汇总，read SKILL.md 保持独立可见
		expect(container.querySelector(".pw-summary")?.textContent).toContain("读了 1 个文件");

		// 点击可展开 SKILL.md 原始内容
		const btn = skillStep!.querySelector(".pw-line-interactive")!;
		expect(btn.getAttribute("aria-expanded")).toBe("false");
		fireEvent.click(btn);
		expect(btn.getAttribute("aria-expanded")).toBe("true");
		expect(skillStep?.textContent).toContain("# Plan Review");
	});
});
