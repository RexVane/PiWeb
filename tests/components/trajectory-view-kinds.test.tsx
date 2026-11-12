// @vitest-environment jsdom
/** 轨迹视图里的扩展消息与用户 ! 命令：它们是进入模型输入的内容，不开新的一轮，折叠回合时仍然留着 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TrajectoryView, TrajInspector } from "@/components/TrajectoryView";
import type { TrajEntry } from "@/lib/types";

afterEach(cleanup);

const entries: TrajEntry[] = [
	{ seq: 1, kind: "user", ts: 1000, detail: "帮我重构" },
	{ seq: 2, kind: "custom", ts: 1100, title: "plan-mode", detail: "已进入计划模式" },
	{ seq: 3, kind: "message", ts: 1200, title: "assistant", detail: "好的，我先看看" },
	{ seq: 4, kind: "tool", ts: 1300, toolName: "read", toolCallId: "c1", title: "read", detail: "{}" },
	{ seq: 5, kind: "bash", ts: 1400, title: "! git status --short", detail: "git status --short\n\n---\n\n M src/a.ts" },
];

describe("TrajectoryView 里的扩展消息与 ! 命令", () => {
	it("各有自己的类型标签，折叠回合后仍然留着", () => {
		const { container } = render(<TrajectoryView entries={entries} selected={null} onSelect={() => {}} />);
		const kinds = () => [...container.querySelectorAll("button[data-kind]")].filter((row) => row.className.includes("row")).map((row) => row.getAttribute("data-kind"));
		expect(screen.getByText("EXTENSION")).toBeTruthy();
		expect(screen.getByText("SHELL")).toBeTruthy();
		expect(screen.getByText("已进入计划模式")).toBeTruthy();
		// 列表是倒序的（最新在上）
		expect(kinds()).toEqual(["bash", "tool", "message", "custom", "user"]);
		fireEvent.click(screen.getByRole("button", { name: /Turns/ }));
		expect(kinds()).toEqual(["bash", "custom", "user"]);
	});

	it("详情里写明来源", () => {
		render(<TrajInspector entry={entries[1]} onClose={() => {}} />);
		expect(screen.getByText("Pi extension · sendMessage · plan-mode")).toBeTruthy();
		cleanup();
		render(<TrajInspector entry={entries[4]} onClose={() => {}} />);
		expect(screen.getByText("Pi AgentSession · user shell command")).toBeTruthy();
	});
});
