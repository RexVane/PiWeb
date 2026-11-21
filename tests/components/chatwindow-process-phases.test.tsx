// @vitest-environment jsdom
/**
 * 过程时间轴（Phase Relay / ThoughtThread / ActionCluster / 语义命令 / 纯心跳 π 行）验证。
 */
import { afterEach, describe, expect, it } from "vitest";
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
		const blocks = buildProcessBlocks(items, -1, spanOf, { turnLive: true });

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
		const blocks = buildProcessBlocks(items, -1, () => 4000, { turnLive: true });

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

		// Bottom π row stays purely informational and non-expandable
		const workStep = container.querySelector('.pw-step[data-kind="work"]') as HTMLElement | null;
		expect(workStep).not.toBeNull();
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

		// Prior completed phase collapsed into deterministic summary without phase numbering
		const summaryBtn = container.querySelector(".pw-summary") as HTMLElement | null;
		expect(summaryBtn).not.toBeNull();
		expect(summaryBtn!.textContent).toContain("探测端口与进程");
		expect(summaryBtn!.textContent).not.toContain("阶段 1");
		expect(summaryBtn!.textContent).not.toContain("含 1 段思考");

		// Active phase remains expanded below
		expect(await screen.findByText("First phase found port 15721.", {}, { timeout: 5000 })).toBeTruthy();
		expect(screen.getByRole("button", { name: /正在思考下一步/ })).toBeTruthy();
	});

	it("groups >= 2 completed thoughts inside ThoughtThread without trailing preview, translates model command intent, and keeps raw user ! commands", () => {
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

		// Completed turn button keeps exact accessible duration label + ActionCluster
		const turnToggle = screen.getByRole("button", { name: "用时 1m 0s" });
		expect(turnToggle.querySelectorAll(".pw-cluster-dot").length).toBeGreaterThanOrEqual(2);
		fireEvent.click(turnToggle);

		// User `!` bash command stays raw
		expect(screen.getByText("Get-NetTCPConnection -LocalPort 18080")).toBeTruthy();

		// Expand collapsed phase
		const summaryBtn = container.querySelector(".pw-summary") as HTMLButtonElement;
		expect(summaryBtn.textContent).toContain("探测端口与进程");
		fireEvent.click(summaryBtn);

		// 3 thoughts grouped into ThoughtThread with no English trailing snippet
		const threadBtn = screen.getByRole("button", { name: "本阶段推理 · 3 段思考" });
		expect(threadBtn.textContent).not.toContain("Alpha thought");
		fireEvent.click(threadBtn);
		expect(container.querySelectorAll(".pw-think-bead").length).toBe(3);

		// Model command renders semantic intent + target + inspect badge, while raw command remains in expanded .pw-output
		const cmdStep = container.querySelector('.pw-step[data-kind="cmd"]') as HTMLElement;
		expect(cmdStep.querySelector('.pw-icon[data-badge="inspect"]')).not.toBeNull();
		expect(cmdStep.textContent).toContain("探测端口与进程");
		expect(cmdStep.textContent).toContain(":15721");

		const toolToggle = cmdStep.querySelector('[role="button"]') as HTMLElement;
		fireEvent.click(toolToggle);
		expect(cmdStep.querySelector(".pw-output .cmdline")?.textContent).toBe(fullPsCmd);
	});

	it("segments long write+run debug loops into milestone phases with compact Temp paths and no trailing final thinking", () => {
		const tempDir = "C:/Users/guica/AppData/Local/Temp/codex-sniff";
		const scripts = ["devs.py", "capture.py", "peek.py", "analyze.py", "report.py", "reqs.py", "dump.py", "probe.py"];
		const assistantMsgs: WebMessage[] = [
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "Find the proxy port and inspect config dir." },
					{ type: "toolCall", id: "p1", name: "bash", arguments: { command: "Get-NetTCPConnection -LocalPort 15721" } },
					{ type: "toolCall", id: "p2", name: "bash", arguments: { command: `Get-ChildItem "${tempDir}"` } },
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
			p1: { name: "bash", args: {}, state: "done", result: ":15721", startedAt: 1_000, endedAt: 5_000 },
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

		fireEvent.click(screen.getByRole("button", { name: "用时 3m 0s" }));

		const phaseRuns = container.querySelectorAll(".pw-run");
		expect(phaseRuns.length).toBeGreaterThanOrEqual(3);
		expect(phaseRuns.length).toBeLessThanOrEqual(6);

		// Top-level summaries show milestone filenames and +N diff badges without Temp prefix noise
		const summaryText = Array.from(container.querySelectorAll(".pw-summary")).map((el) => el.textContent ?? "").join(" | ");
		expect(summaryText).toContain("devs.py");
		expect(summaryText).toContain("probe.py");
		expect(container.querySelectorAll(".pw-phase-diff .pw-add").length).toBeGreaterThanOrEqual(2);

		// Concluding finalIdx English thought folds inside the concluding phase rather than hanging exposed at bottom
		expect(screen.queryByText(/The probes show in 7 out 11/)).toBeNull();

		// Expanding a write-containing phase shows shortened Temp path while keeping full path in title tooltip
		fireEvent.click(container.querySelectorAll(".pw-summary")[1]!);
		expect(container.textContent).toContain("Temp/codex-sniff/");
		expect(container.textContent).not.toContain("C:/Users/guica/AppData/Local/Temp");
	});

	it("keeps pure code exploration consolidated rather than cloning rows every 6 steps, and keeps targets clean", () => {
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

		const blocks = buildProcessBlocks(exploreItems, -1, () => 4000, { turnLive: false });
		// Instead of splitting 14 searches into 3 cloned search blocks, pure exploration stays 1 clean phase
		expect(blocks.length).toBeLessThanOrEqual(3);
		expect(blocks[0].kind).toBe("run");
		if (blocks[0].kind === "run") {
			expect(blocks[0].cluster).toEqual(["inspect"]);
			expect(blocks[0].intentTargets.map((t) => t.target)).toContain("activatedOnRegistration");
			expect(blocks[0].intentTargets.map((t) => t.target).join(" ")).not.toMatch(/\b30\b|\*\.ts|\*/);
		}
	});
});
