// @vitest-environment jsdom
/**
 * 过程时间轴（Phase Relay / 原位思考穿插 / ActionCluster / 语义命令 / 纯心跳 π 行）验证。
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ChatWindow } from "@/components/ChatWindow";
import type { ToolCardState } from "@/hooks/usePiWeb";
import {
	LIVE_FRONTIER_KEEP_TAIL,
	LIVE_FRONTIER_MAX_ITEMS,
	buildProcessBlocks,
	type ProcessItem,
} from "@/lib/process-phases";
import type { WebMessage } from "@/lib/types";

beforeAll(async () => {
	await import("@/components/MarkdownBlock");
}, 20_000);

afterEach(cleanup);

function makeBashItem(key: string, msgIndex: number, command: string): Extract<ProcessItem, { kind: "tool" }> {
	return {
		kind: "tool",
		key,
		msgIndex,
		call: { type: "toolCall", id: `call-${key}`, name: "bash", arguments: { command } },
		state: {
			name: "bash",
			args: { command },
			state: "done",
			result: "ok",
			startedAt: msgIndex * 1000,
			endedAt: msgIndex * 1000 + 2000,
		},
	};
}

describe("buildProcessBlocks relay collapsing", () => {
	it("collapses completed prior phase when next narration begins while streaming", () => {
		const items: ProcessItem[] = [
			{ kind: "think", key: "1-0", msgIndex: 1, text: "Check port 15721 first.", live: false },
			makeBashItem("1-1", 1, "Get-NetTCPConnection -LocalPort 15721"),
			{ kind: "narr", key: "2-0", msgIndex: 2, text: "Found listener, checking logs.", live: false, error: false },
			{ kind: "think", key: "2-1", msgIndex: 2, text: "Now reading config database.", live: true },
		];
		const spanOf = (a: number, b: number) => (b - a + 1) * 2000;
		const blocks = buildProcessBlocks(items, spanOf, { turnLive: true });

		expect(blocks[0].kind).toBe("run");
		if (blocks[0].kind === "run") {
			expect(blocks[0].intentCategories).toEqual(["port_proc"]);
			expect(blocks[0].cluster).toEqual(["think", "inspect"]);
		}
		expect(blocks[1]).toMatchObject({ kind: "item", item: { kind: "narr" } });
		expect(blocks[2]).toMatchObject({ kind: "item", item: { kind: "think", live: true } });
	});

	it("folds earlier prefix items when narration-less streak exceeds frontier threshold", () => {
		const count = LIVE_FRONTIER_MAX_ITEMS + 2;
		const items: ProcessItem[] = Array.from({ length: count }, (_, idx) =>
			makeBashItem(`1-${idx}`, 1, idx % 2 === 0 ? "Get-ChildItem src" : "Get-NetTCPConnection -LocalPort 8080"),
		);
		const blocks = buildProcessBlocks(items, () => 4000, { turnLive: true });

		expect(blocks[0].kind).toBe("run");
		if (blocks[0].kind === "run") {
			expect(blocks[0].items.length).toBe(count - LIVE_FRONTIER_KEEP_TAIL);
		}
		expect(blocks.slice(1).length).toBe(LIVE_FRONTIER_KEEP_TAIL);
		expect(blocks.slice(1).every((b) => b.kind === "item")).toBe(true);
	});
});

describe("ChatWindow process phases UI", () => {
	it("keeps WorkingStep non-expandable without step counters while live thinking streams in place", () => {
		const messages: WebMessage[] = [
			{ role: "user", content: [{ type: "text", text: "check service" }], timestamp: 1_000 },
			{
				role: "assistant",
				content: [{ type: "thinking", thinking: "Inspecting local TCP listeners on port 15721." }],
				timestamp: 2_000,
			},
		];

		const { container } = render(<ChatWindow messages={messages} tools={{}} isStreaming />);

		// Active thinking row renders in-situ with clickable expansion and live copy
		const thinkBtn = screen.getByRole("button", { name: /正在思考下一步/ });
		expect(container.querySelector(".pw-tail")?.textContent).toContain("15721");
		fireEvent.click(thinkBtn);
		expect(container.querySelector(".pw-think-full")?.textContent).toContain("Inspecting local TCP listeners");

		// Bottom π row stays purely informational and non-expandable with vector PiMark SVG
		const workStep = container.querySelector('.pw-step[data-kind="work"]') as HTMLElement | null;
		expect(workStep).not.toBeNull();
		expect(workStep!.querySelector(".pw-pi svg")).not.toBeNull();
		expect(workStep!.textContent).toContain("Working…");
		expect(workStep!.querySelector("button")).toBeNull();
		expect(workStep!.textContent).not.toContain("已推进");
		expect(workStep!.textContent).not.toContain("查看实时思路");
	});

	it("relays completed phase into summary header while keeping current phase live", async () => {
		const messages: WebMessage[] = [
			{ role: "user", content: [{ type: "text", text: "diagnose" }], timestamp: 1_000 },
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "Step one thinking." },
					{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "Get-NetTCPConnection -LocalPort 15721" } },
				],
				timestamp: 2_000,
				durationMs: 3000,
			},
			{
				role: "assistant",
				content: [
					{ type: "text", text: "First phase found port 15721." },
					{ type: "thinking", thinking: "Now checking directory contents." },
				],
				timestamp: 6_000,
			},
		];
		const tools: Record<string, ToolCardState> = {
			t1: {
				name: "bash",
				args: { command: "Get-NetTCPConnection -LocalPort 15721" },
				state: "done",
				result: "OwningProcess: 9912",
				startedAt: 2_000,
				endedAt: 5_000,
			},
		};

		const { container } = render(<ChatWindow messages={messages} tools={tools} isStreaming />);

		// Prior completed phase collapsed into phase summary with far-left icon and counted actions
		const summaryBtn = container.querySelector(".pw-summary") as HTMLElement | null;
		expect(summaryBtn).not.toBeNull();
		expect(summaryBtn!.textContent).toContain("思考了 3s");
		expect(summaryBtn!.textContent).toContain("运行了 1 条命令");
		expect(summaryBtn!.textContent).not.toContain("探测端口与进程");
		expect(summaryBtn!.textContent).not.toContain("阶段 1");
		expect(container.querySelector(".pw-step-summary .pw-icon svg")).not.toBeNull();

		// Active phase remains expanded below
		expect(await screen.findByText("First phase found port 15721.", {}, { timeout: 5000 })).toBeTruthy();
		expect(screen.getByRole("button", { name: /正在思考下一步/ })).toBeTruthy();
	});

	it("keeps completed thoughts chronologically interleaved with tool steps inside expanded phase, shows raw commands directly, and keeps raw user ! commands", () => {
		const fullPsCmd = "Get-NetTCPConnection -LocalPort 15721 | Select-Object LocalPort, OwningProcess";
		const messages: WebMessage[] = [
			{ role: "user", content: [{ type: "text", text: "audit proxy" }], timestamp: 0 },
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "Alpha thought paragraph one." },
					{ type: "toolCall", id: "t1", name: "bash", arguments: { command: fullPsCmd } },
					{ type: "thinking", thinking: "Beta thought paragraph two." },
					{ type: "thinking", thinking: "Gamma thought paragraph three." },
				],
				timestamp: 1_000,
				durationMs: 4000,
			},
			{
				role: "bashExecution",
				content: [],
				bash: { command: "Get-NetTCPConnection -LocalPort 18080", output: "ok" },
				timestamp: 5_000,
			},
			{
				role: "assistant",
				content: [{ type: "text", text: "Done auditing." }],
				timestamp: 60_000,
				endedAt: 60_000,
			},
		];
		const tools: Record<string, ToolCardState> = {
			t1: {
				name: "bash",
				args: { command: fullPsCmd },
				state: "done",
				result: "LocalPort: 15721",
				startedAt: 1_500,
				endedAt: 3_500,
			},
		};

		const { container } = render(<ChatWindow messages={messages} tools={tools} isStreaming={false} />);

		// Completed turn defaults to collapsed with status dot + duration (no trailing counts), and opens phase summary
		const turnToggle = screen.getByRole("button", { name: "用时 1m 0s" });
		expect(turnToggle.getAttribute("aria-expanded")).toBe("false");
		expect(turnToggle.querySelector(".pw-turn-dot")).not.toBeNull();
		expect(turnToggle.textContent).not.toContain("思考");
		expect(turnToggle.textContent).not.toContain("运行");
		expect(turnToggle.querySelector(".pw-cluster")).toBeNull();
		expect(container.querySelector(".pw-turn-body")?.getAttribute("data-collapsed")).toBe("true");

		fireEvent.click(turnToggle);
		expect(turnToggle.getAttribute("aria-expanded")).toBe("true");
		expect(container.querySelector(".pw-turn-body")?.getAttribute("data-collapsed")).toBeNull();

		// Collapsed summary row holds think + cmd inside expanded turn; user `!` bash command stays outside
		const summaryBtn = container.querySelector(".pw-summary") as HTMLElement;
		expect(summaryBtn.textContent).toContain("思考了 4s");
		expect(summaryBtn.textContent).toContain("运行了 1 条命令");
		expect(container.querySelector(".pw-step-summary .pw-icon svg")).not.toBeNull();
		expect(screen.getByText("Get-NetTCPConnection -LocalPort 18080")).toBeTruthy();

		// Expanding phase summary keeps thoughts chronologically interleaved with command step and far-left icons
		fireEvent.click(summaryBtn);
		const phaseSteps = Array.from(container.querySelectorAll(".pw-phase-body > .pw-step"));
		expect(phaseSteps.map((el) => el.getAttribute("data-kind"))).toEqual(["think", "cmd", "think", "think"]);
		expect(phaseSteps[0]!.querySelector(".pw-icon svg")).not.toBeNull();

		const firstThinkBtn = screen.getByRole("button", { name: /Alpha thought paragraph one/ });
		fireEvent.click(firstThinkBtn);
		expect(container.querySelector(".pw-think-full")?.textContent).toBe("Alpha thought paragraph one.");

		const cmdStep = phaseSteps[1] as HTMLElement;
		expect(cmdStep.querySelector('.pw-icon[data-badge="exec"] svg')).not.toBeNull();
		expect(cmdStep.textContent).toContain(fullPsCmd);
		expect(cmdStep.textContent).toContain("已运行");

		const toolToggle = cmdStep.querySelector('[role="button"]') as HTMLElement;
		fireEvent.click(toolToggle);
		expect(cmdStep.querySelector(".pw-output .cmdline")?.textContent).toBe(fullPsCmd);
	});

	it("renders long write+run debug loops directly under π turn toggle in original order with compact Temp paths and clean +N diffs", () => {
		const tempDir = "/c/Users/guica/AppData/Local/Temp/codex-sniff";
		const scripts = ["devs.py", "capture.py", "peek.py", "analyze.py", "report.py", "reqs.py", "dump.py", "probe.py"];
		const assistantMsgs: WebMessage[] = [
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "Find the proxy port and inspect config dir." },
					{ type: "toolCall", id: "p1", name: "bash", arguments: { command: 'cd ~/.cc-switch && python -c "\nimport sqlite3, json\nprint(1)\n"' } },
					{ type: "toolCall", id: "p2", name: "bash", arguments: { command: `cd "${tempDir}" && rm -f s*.bin && python devs.py` } },
					{ type: "toolCall", id: "p3", name: "bash", arguments: { command: `python "${tempDir}/devs.py"` } },
				],
				timestamp: 1_000,
				durationMs: 25_000,
			},
			...scripts.map((file, idx): WebMessage => ({
				role: "assistant",
				content: [
					{ type: "thinking", thinking: `Iterate on ${file}` },
					{ type: "toolCall", id: `w-${idx}`, name: "write", arguments: { path: `${tempDir}/${file}`, content: "print('hi')\nprint('ok')\n" } },
					{ type: "toolCall", id: `r-${idx}`, name: "bash", arguments: { command: `python "${tempDir}/${file}"` } },
				],
				timestamp: 30_000 + idx * 10_000,
				durationMs: 8_000,
			})),
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "The probes show in 7 out 11 at 00:55:52 — trailing raw English thought." },
					{ type: "text", text: "最终分析完成。" },
				],
				timestamp: 180_000,
				endedAt: 180_000,
			},
		];

		const tools: Record<string, ToolCardState> = {
			p1: { name: "bash", args: {}, state: "done", result: "ok", startedAt: 1_000, endedAt: 5_000 },
			p2: { name: "bash", args: {}, state: "done", result: "dir", startedAt: 5_000, endedAt: 10_000 },
			p3: { name: "bash", args: {}, state: "done", result: "ok", startedAt: 10_000, endedAt: 15_000 },
		};
		scripts.forEach((file, idx) => {
			tools[`w-${idx}`] = { name: "write", args: { path: `${tempDir}/${file}`, content: "print('hi')\nprint('ok')\n" }, state: "done", startedAt: 30_000 + idx * 10_000, endedAt: 32_000 + idx * 10_000 };
			tools[`r-${idx}`] = { name: "bash", args: { command: `python "${tempDir}/${file}"` }, state: "done", result: "ok", startedAt: 32_000 + idx * 10_000, endedAt: 38_000 + idx * 10_000 };
		});

		const { container } = render(
			<ChatWindow
				messages={[{ role: "user", content: [{ type: "text", text: "抓包分析" }], timestamp: 0 }, ...assistantMsgs]}
				tools={tools}
				isStreaming={false}
			/>,
		);

		// Collapsed by default after completion; expanding reveals external write milestones alongside calm phase summaries
		const turnToggle = screen.getByRole("button", { name: "用时 3m 0s" });
		expect(container.querySelector(".pw-turn-body")?.getAttribute("data-collapsed")).toBe("true");
		fireEvent.click(turnToggle);
		expect(container.querySelector(".pw-turn-body")?.getAttribute("data-collapsed")).toBeNull();

		const turnBody = container.querySelector(".pw-turn-body-inner")!;
		// Writes stay outside .pw-run as visible milestone rows with far-left icon, compact Temp paths, +2 diff, and duration
		const externalWrites = Array.from(turnBody.querySelectorAll(':scope > .pw-step[data-kind="write"]'));
		expect(externalWrites).toHaveLength(scripts.length);
		expect(externalWrites[0]!.querySelector(".pw-icon svg")).not.toBeNull();
		expect(turnBody.textContent).toContain("Temp/codex-sniff/");
		expect(turnBody.textContent).not.toContain("/cTemp/");
		expect(turnBody.textContent).not.toContain("/c/Users/guica/AppData/Local/Temp");
		expect(turnBody.querySelectorAll(".pw-phase-diff .pw-add")).toHaveLength(scripts.length);
		expect(turnBody.querySelectorAll(".pw-phase-diff .pw-del")).toHaveLength(0);
		expect(turnBody.textContent).not.toContain("已删除");
		expect(turnBody.textContent).not.toContain("−0");

		// Expanding phase summaries reveals preserved cmd formatting and trailing thought in exact chronological position
		turnBody.querySelectorAll<HTMLButtonElement>(".pw-summary").forEach((btn) => fireEvent.click(btn));
		expect(turnBody.textContent).toContain('cd ~/.cc-switch && python -c "import sqlite3, json …"');
		expect(turnBody.textContent).toContain("· 4L");
		expect(turnBody.textContent).not.toContain("行脚本");
		expect(turnBody.textContent).toContain("The probes show in 7 out 11");
	});

	it("keeps pure code exploration consolidated while keeping write milestones visible between exploration phases", () => {
		const exploreItems: ProcessItem[] = [
			...Array.from({ length: 14 }, (_, idx) =>
				makeBashItem(
					`s-${idx}`,
					1 + idx,
					idx % 2 === 0
						? `rg -n -C 30 "activatedOnRegistration" src/components`
						: `Get-ChildItem -Path src/agent -Filter *.ts`,
				),
			),
			{
				kind: "tool",
				key: "w-loader",
				msgIndex: 15,
				call: { type: "toolCall", id: "w-loader", name: "write", arguments: { path: "Temp/loader_test.mjs", content: "console.log(1)\n" } },
				state: { name: "write", args: { path: "Temp/loader_test.mjs", content: "console.log(1)\n" }, state: "done", startedAt: 15000, endedAt: 16000 },
			},
			makeBashItem("r-loader", 16, "node Temp/loader_test.mjs"),
			makeBashItem("s-after-1", 17, `rg -n -g "*.ts" "disabledPackages" src/lib/route.ts`),
			makeBashItem("s-after-2", 18, `Get-Content web-resources.json -TotalCount 60`),
		];

		const blocks = buildProcessBlocks(exploreItems, () => 4000, { turnLive: false });
		// Exploration phases stay consolidated around external write milestones rather than cloning rows every 6 steps
		expect(blocks).toHaveLength(3);
		expect(blocks[0].kind).toBe("run");
		if (blocks[0].kind === "run") {
			expect(blocks[0].cluster).toEqual(["inspect"]);
			expect(blocks[0].cmds).toBe(14);
			expect(blocks[0].writes).toBe(0);
			expect(blocks[0].intentTargets.map((t) => t.target)).toContain("activatedOnRegistration");
			expect(blocks[0].intentTargets.map((t) => t.target).join(" ")).not.toMatch(/\b30\b|\*\.ts|\*/);
		}
		expect(blocks[1]).toMatchObject({ kind: "item", item: { key: "w-loader" } });
		expect(blocks[2]).toMatchObject({ kind: "run", cmds: 3 });
	});

	it("renders aligned single-icon summary headers with right-aligned compact cluster and clean failure callout while preserving step order", () => {
		const targetPath = "~/.pi/agent/npm/node_modules/@juicesharp/rpiv-todo/todo-overlay.ts";
		const winPkgDir = "C:\\Users\\guica\\.pi\\agent\\npm\\node_modules\\@juicesharp\\rpiv-todo";
		const psErr = [
			"Line |",
			'   2 | ... Host "---"; Select-String -Path "C:\\Users\\guica\\.pi\\agent\\npm\\node_mo ...',
			"     |                        ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~",
			`     | Cannot find path '${winPkgDir}' because it does not exist.`,
			"",
			"Command exited with code 1",
		].join("\n");

		const assistantMsgs: WebMessage[] = [
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "Inspect plugin files first" },
					{ type: "toolCall", id: "r_ok", name: "read", arguments: { path: "src/app/globals.css" } },
					{ type: "toolCall", id: "g_ok", name: "grep", arguments: { pattern: "rpiv-todo", path: "src" } },
					{ type: "thinking", thinking: "Try fallback location next" },
				],
				timestamp: 1_000,
				durationMs: 4_000,
			},
			{
				role: "assistant",
				content: [
					{ type: "text", text: "面板没出来，先继续排查。" },
					{ type: "toolCall", id: "r1", name: "read", arguments: { path: targetPath } },
					{ type: "toolCall", id: "b1", name: "bash", arguments: { command: `Select-String -Path "${winPkgDir}" -Pattern list` } },
				],
				timestamp: 6_000,
				durationMs: 6_000,
			},
			{
				role: "assistant",
				content: [{ type: "text", text: "未能读取该目录。" }],
				timestamp: 13_000,
				endedAt: 13_000,
			},
		];

		const tools: Record<string, ToolCardState> = {
			r_ok: {
				name: "read",
				args: { path: "src/app/globals.css" },
				state: "done",
				result: "/* ok */",
				startedAt: 1_500,
				endedAt: 2_500,
			},
			g_ok: {
				name: "grep",
				args: { pattern: "rpiv-todo", path: "src" },
				state: "done",
				result: "no match",
				startedAt: 2_500,
				endedAt: 4_000,
			},
			r1: {
				name: "read",
				args: { path: targetPath },
				state: "done",
				isError: true,
				result: `ENOENT: no such file or directory, access '${winPkgDir}\\todo-overlay.ts'`,
				startedAt: 6_500,
				endedAt: 8_000,
			},
			b1: {
				name: "bash",
				args: { command: `Select-String -Path "${winPkgDir}" -Pattern list` },
				state: "done",
				isError: true,
				result: psErr,
				startedAt: 8_000,
				endedAt: 11_000,
			},
		};

		const { container } = render(
			<ChatWindow
				messages={[{ role: "user", content: [{ type: "text", text: "查一下 rpiv-todo" }], timestamp: 0 }, ...assistantMsgs]}
				tools={tools}
				isStreaming={false}
			/>,
		);

		const turnToggle = screen.getByRole("button", { name: "用时 13s" });
		expect(turnToggle.getAttribute("aria-expanded")).toBe("false");
		fireEvent.click(turnToggle);

		const turnBody = container.querySelector(".pw-turn-body-inner");
		expect(turnBody).not.toBeNull();

		// Pre-narration phase collapses into single-icon SummaryStep without redundant inner cluster; failed tools stay outside
		const summaryBtn = turnBody!.querySelector(".pw-summary") as HTMLElement | null;
		expect(summaryBtn).not.toBeNull();
		expect(summaryBtn!.textContent).toContain("思考了 4s");
		expect(summaryBtn!.textContent).toContain("读了 1 个文件");
		expect(summaryBtn!.textContent).toContain("搜索了 1 次");
		expect(turnBody!.querySelector(".pw-cluster")).toBeNull();
		expect(turnBody!.querySelector(".pw-step-summary .pw-icon svg")).not.toBeNull();

		fireEvent.click(summaryBtn!);
		const stepEls = Array.from(turnBody!.querySelectorAll(".pw-phase-body > .pw-step"));
		expect(stepEls.map((el) => el.getAttribute("data-kind"))).toEqual(["think", "read", "search", "think"]);
		expect(stepEls[0]!.querySelector(".pw-icon svg")).not.toBeNull();
		expect(stepEls[1]!.querySelector(".pw-icon svg")).not.toBeNull();
		expect(stepEls[1]!.querySelector(".pw-arg-file")).not.toBeNull();
		expect(stepEls[2]!.querySelector(".pw-icon svg")).not.toBeNull();
		expect(stepEls[3]!.querySelector(".pw-icon svg")).not.toBeNull();
		const stepTexts = stepEls.map((el) => el.textContent ?? "");
		expect(stepTexts[0]).toContain("Inspect plugin files first");
		expect(stepTexts[1]).toContain("已读取");
		expect(stepTexts[1]).toContain("src/app/globals.css");
		expect(stepTexts[2]).toContain("已搜索");
		expect(stepTexts[3]).toContain("Try fallback location next");

		// Failed steps stay outside phase summaries with far-left alert icons, inline status heads, and borderless note rails
		const turnText = turnBody!.textContent ?? "";
		expect(turnBody!.querySelector(".pw-narr")).not.toBeNull();
		expect(turnBody!.querySelectorAll('.pw-step[data-tone="fail"] .pw-icon svg').length).toBe(2);
		expect(turnBody!.querySelector(".pw-arg-dir")?.textContent).toBeTruthy();
		expect(turnBody!.querySelector(".pw-arg-leaf")?.textContent).toBeTruthy();
		expect(turnBody!.querySelectorAll(".pw-result[data-failed='true']").length).toBe(2);
		const failedToolSteps = Array.from(turnBody!.querySelectorAll('.pw-step[data-tone="fail"]'));
		expect(failedToolSteps).toHaveLength(2);
		// Single-line failed read step does not attach a redundant raw toggle button
		expect(failedToolSteps[0]!.querySelector('[role="button"]')).toBeNull();
		// Failed bash command keeps a clickable toggle that expands .pw-output .cmdline inline
		const bashToggle = failedToolSteps[1]!.querySelector('[role="button"]') as HTMLElement | null;
		expect(bashToggle).not.toBeNull();
		fireEvent.click(bashToggle!);
		expect(failedToolSteps[1]!.querySelector(".pw-output .cmdline")?.textContent).toContain("Select-String");

		expect(turnText).toContain("失败 · 退出码 1");
		expect(turnText).toContain("Cannot find path '~/.pi/agent/npm/node_modules/@juicesharp/rpiv-todo' because it does not exist.");
		expect(turnText).not.toContain("Line |");
		expect(turnText).not.toContain("~~~~");
		expect(turnBody!.querySelector(".pw-rail")).toBeNull();
		expect(turnText).not.toContain("⎿");
	});

	it("renders timed-out/failed short commands directly in order and avoids redundant .cmdline and blank gaps", () => {
		const assistantMsgs: WebMessage[] = [
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "Try first echo command." },
					{ type: "toolCall", id: "b1", name: "bash", arguments: { command: "echo stop" } },
					{ type: "thinking", thinking: "Wait, echo stop timed out; try last." },
					{ type: "toolCall", id: "b2", name: "bash", arguments: { command: 'echo "last"' } },
					{ type: "thinking", thinking: "Now check a passing command." },
					{ type: "toolCall", id: "b3", name: "bash", arguments: { command: "echo ok" } },
				],
				timestamp: 1_000,
				durationMs: 12_000,
			},
			{
				role: "assistant",
				content: [{ type: "text", text: "测试结束。" }],
				timestamp: 15_000,
				endedAt: 15_000,
			},
		];
		const tools: Record<string, ToolCardState> = {
			b1: { name: "bash", args: { command: "echo stop" }, state: "done", isError: true, result: "stop\n\n\nCommand timed out after 2 seconds" },
			b2: { name: "bash", args: { command: 'echo "last"' }, state: "done", isError: true, result: "last\n\n\n\nCommand timed out after 2 seconds" },
			b3: { name: "bash", args: { command: "echo ok" }, state: "done", result: "ok" },
		};

		const { container } = render(
			<ChatWindow
				messages={[{ role: "user", content: [{ type: "text", text: "测试命令" }], timestamp: 0 }, ...assistantMsgs]}
				tools={tools}
				isStreaming={false}
			/>,
		);

		const turnToggle = screen.getByRole("button", { name: "用时 15s" });
		expect(turnToggle.getAttribute("aria-expanded")).toBe("false");
		fireEvent.click(turnToggle);

		const turnBody = container.querySelector(".pw-turn-body-inner")!;
		const failedCmds = Array.from(turnBody.querySelectorAll('.pw-step[data-kind="cmd"][data-tone="fail"]'));
		expect(failedCmds).toHaveLength(2);

		const secondCmd = failedCmds[1]!;
		const toggle = secondCmd.querySelector('[role="button"]') as HTMLElement;
		fireEvent.click(toggle);
		expect(secondCmd.querySelector(".pw-output .cmdline")).toBeNull();
		const outputPreText = secondCmd.querySelector(".pw-output pre")?.textContent ?? "";
		expect(outputPreText).toBe("last\n\nCommand timed out after 2 seconds");
	});

	it("splits subsequent assistant turns after a final answer instead of merging behind the previous result", () => {
		const initialAnswer: WebMessage = {
			role: "assistant",
			id: "prev-final",
			content: [{ type: "text", text: "上一轮结论完成。" }],
			stopReason: "stop",
			timestamp: 2_000,
			endedAt: 5_000,
		};
		const followUpTool: WebMessage = {
			role: "assistant",
			id: "goal-step-1",
			content: [
				{ type: "thinking", thinking: "Continue goal verification next." },
				{ type: "toolCall", id: "e-next", name: "edit", arguments: { path: "src/app.ts", oldText: "a", newText: "b" } },
			],
			stopReason: "toolUse",
			timestamp: 6_000,
			durationMs: 2_000,
		};
		const followUpAborted: WebMessage = {
			role: "assistant",
			id: "goal-abort",
			content: [],
			stopReason: "aborted",
			timestamp: 8_000,
		};
		const followUpDone: WebMessage = {
			role: "assistant",
			id: "goal-final",
			content: [{ type: "text", text: "自动续跑完成。" }],
			stopReason: "stop",
			timestamp: 10_000,
			endedAt: 10_000,
		};
		const tools: Record<string, ToolCardState> = {
			"e-next": {
				name: "edit",
				args: { path: "src/app.ts" },
				state: "done",
				patch: "@@ -1,1 +1,1 @@\n-a\n+b\n",
				startedAt: 6_500,
				endedAt: 7_500,
			},
		};
		const baseMessages: WebMessage[] = [
			{ role: "user", id: "u1", content: [{ type: "text", text: "开始" }], timestamp: 1_000 },
			initialAnswer,
		];

		const { container, rerender } = render(
			<ChatWindow messages={[...baseMessages, followUpTool, followUpAborted]} tools={tools} isStreaming={false} />,
		);

		// First turn's final answer remains outside in its own FinalAnswer block rather than merged into follow-up steps
		let finalBlocks = Array.from(container.querySelectorAll('[data-role="assistant"]'));
		expect(finalBlocks).toHaveLength(1);
		expect(finalBlocks[0]!.textContent).toContain("上一轮结论完成。");
		expect(finalBlocks[0]!.textContent).not.toContain("Continue goal verification");
		const processTurns = Array.from(container.querySelectorAll(".pw-turn"));
		expect(processTurns).toHaveLength(1);
		expect(processTurns[0]!.textContent).toContain("src/app.ts");
		expect(processTurns[0]!.textContent).not.toContain("上一轮结论完成。");

		// When the follow-up round finishes with its own final answer, it defaults to collapsed and reveals edit + thought on expand
		rerender(<ChatWindow messages={[...baseMessages, followUpTool, followUpDone]} tools={tools} isStreaming={false} />);
		finalBlocks = Array.from(container.querySelectorAll('[data-role="assistant"]'));
		expect(finalBlocks).toHaveLength(2);
		expect(finalBlocks[0]!.textContent).toContain("上一轮结论完成。");
		expect(finalBlocks[1]!.textContent).toContain("自动续跑完成。");
		expect(container.querySelector(".pw-turn-body")?.getAttribute("data-collapsed")).toBe("true");
		fireEvent.click(container.querySelector(".pw-turn-toggle")!);
		expect(container.querySelector(".pw-turn-body")?.getAttribute("data-collapsed")).toBeNull();
		expect(container.querySelector(".pw-turn-body-inner")?.textContent).toContain("src/app.ts");
		fireEvent.click(screen.getByRole("button", { name: "思考了 2s" }));
		expect(screen.getByRole("button", { name: /Continue goal verification next/ })).toBeTruthy();
	});
});
