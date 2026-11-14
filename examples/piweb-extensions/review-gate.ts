/**
 * 样板 2：审阅闸门。
 *
 * 演示两件事：
 *   1. `code` 节点：把 diff / 命令输出这类等宽内容按网页代码块显示；
 *   2. `list` 当“操作按钮”用：选项带 action，用户点哪个就回哪个。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { code, col, list, openTerminalPanel, piwebUi, txt, type WebUiNode } from "./lib/piweb-ui";

export type ReviewChoice = "approve" | "changes" | "details";

export interface ReviewInput {
	title: string;
	summary: string;
	diff: string;
}

/** 网页版：摘要 + 代码块 + 三个操作 */
export function buildReviewTree(input: ReviewInput): WebUiNode {
	return col(
		txt(input.title, "accent"),
		txt(input.summary, "muted"),
		code(input.diff, "diff"),
		list([
			{ label: "批准", description: "接受这处改动", action: "approve" },
			{ label: "要求修改", description: "打回并说明原因", action: "changes" },
			{ label: "只看细节", description: "展开完整 diff", action: "details" },
		]),
	);
}

/** 终端版：同样的内容画成字符 */
export function renderReviewLines(input: ReviewInput): string[] {
	return [
		input.title,
		input.summary,
		...input.diff.split("\n").map((line) => `  ${line}`),
		"[a] 批准   [c] 要求修改   [d] 只看细节",
	];
}

export default function reviewGate(pi: ExtensionAPI) {
	pi.registerCommand("review", {
		description: "审阅闸门（PiWeb 用网页卡片，终端用字符）",
		handler: async (_args, ctx) => {
			const input: ReviewInput = {
				title: "待审改动：src/lib/plugins-service.ts",
				summary: "改动 2 个文件，+18 −6 行。",
				diff: [
					"@@ -120,6 +120,10 @@ export function listPackages(cwd: string)",
					"-  const out = [];",
					"+  const out: PackageView[] = [];",
					"+  // 包会带上自己的扩展/技能/提示词/主题",
				].join("\n"),
			};

			const web = piwebUi(ctx.ui);
			if (web) {
				const result = await web.web(buildReviewTree(input), { title: "审阅", timeout: 120_000 });
				const choice = result?.action as ReviewChoice | undefined;
				if (!choice) {
					ctx.ui.notify("已取消审阅", "info");
					return;
				}
				if (choice === "details") {
					await web.web(
						col(txt("完整 diff", "accent"), code(input.diff, "diff")),
						{ title: "细节", timeout: 120_000 },
					);
					ctx.ui.notify("已查看细节", "info");
					return;
				}
				ctx.ui.notify(choice === "approve" ? "已批准" : "已要求修改", choice === "approve" ? "info" : "warning");
				return;
			}

			const lines = renderReviewLines(input);
			await openTerminalPanel(ctx.ui, { render: () => lines }, { title: "审阅" });
		},
	});
}
