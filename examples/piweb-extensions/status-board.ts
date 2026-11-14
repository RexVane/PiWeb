/**
 * 样板 3：状态看板。
 *
 * 演示 `table` 和 `form`：表格展示运行中的任务，表单改“并发上限”，提交后带 values 回到扩展。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { col, form, openTerminalPanel, piwebUi, progress, table, txt, type WebUiNode } from "./lib/piweb-ui";

export interface Job {
	name: string;
	status: string;
	progress: number;
}

const jobs: Job[] = [
	{ name: "typecheck", status: "done", progress: 1 },
	{ name: "unit tests", status: "running", progress: 0.62 },
	{ name: "build", status: "queued", progress: 0 },
];

let concurrency = 4;

/** 网页版：表格 + 汇总进度 + 设置表单 */
export function buildBoardTree(limit = concurrency): WebUiNode {
	const done = jobs.filter((job) => job.status === "done").length;
	return col(
		txt(`任务 ${done}/${jobs.length}`, "accent"),
		progress(jobs.length > 0 ? done / jobs.length : 0, "整体进度"),
		table(
			["任务", "状态", "进度"],
			jobs.map((job) => [job.name, job.status, `${Math.round(job.progress * 100)}%`]),
		),
		form(
			[
				{ kind: "input", name: "concurrency", label: "并发上限", value: String(limit) },
				{ kind: "confirm", name: "paused", label: "暂停新任务" },
			],
			"保存",
		),
	);
}

/** 终端版 */
export function renderBoardLines(limit = concurrency): string[] {
	const rows = jobs.map((job) => `${job.name.padEnd(14)} ${job.status.padEnd(8)} ${Math.round(job.progress * 100)}%`);
	return [`任务看板（并发 ${limit}）`, ...rows, "按 s 修改并发上限"];
}

export default function statusBoard(pi: ExtensionAPI) {
	pi.registerCommand("board", {
		description: "状态看板（PiWeb 用表格 + 表单，终端用字符）",
		handler: async (_args, ctx) => {
			const web = piwebUi(ctx.ui);
			if (web) {
				const result = await web.web(buildBoardTree(), { title: "状态看板", timeout: 120_000 });
				const raw = result?.values?.concurrency;
				const next = Number(raw);
				if (Number.isFinite(next) && next > 0) {
					concurrency = Math.min(32, Math.round(next));
					ctx.ui.notify(`并发上限改为 ${concurrency}`, "info");
				}
				if (result?.values?.paused === true) ctx.ui.notify("已暂停新任务", "warning");
				return;
			}
			const lines = renderBoardLines();
			await openTerminalPanel(ctx.ui, { render: () => lines }, { title: "状态看板" });
		},
	});
}
