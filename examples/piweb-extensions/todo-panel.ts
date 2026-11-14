/**
 * 样板 1：待办面板。
 *
 * 同一个面板两套渲染：
 *   - 终端：`render(width)` 返回字符行（原来怎么写还怎么写）；
 *   - PiWeb：`ctx.ui.web(tree)` 给一棵树，网页用自己的组件画。点击某一项会带着 action 回来。
 *
 * 数据、状态、逻辑只有一份。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { col, list, openTerminalPanel, piwebUi, progress, txt, type WebUiNode } from "./lib/piweb-ui";

export interface TodoTask {
	id: string;
	title: string;
	done: boolean;
}

/** 网页版：待办清单（进度 + 可点列表） */
export function buildTodoTree(tasks: readonly TodoTask[], selected?: number): WebUiNode {
	const done = tasks.filter((task) => task.done).length;
	return col(
		txt(`待办 ${done}/${tasks.length}`, "accent"),
		progress(tasks.length > 0 ? done / tasks.length : 0, "完成度"),
		list(
			tasks.map((task) => ({
				label: task.title,
				description: task.done ? "已完成" : "未完成",
				action: `toggle:${task.id}`,
			})),
			selected,
		),
		txt("点一项可以切换完成状态", "muted"),
	);
}

/** 终端版：同样的数据，画成字符行 */
export function renderTodoLines(tasks: readonly TodoTask[], width = 60): string[] {
	const done = tasks.filter((task) => task.done).length;
	const lines = [`待办 ${done}/${tasks.length}`];
	for (const task of tasks) {
		const prefix = task.done ? "✔" : "·";
		lines.push(`${prefix} ${task.title}`.slice(0, width));
	}
	lines.push("按 Esc 关闭");
	return lines;
}

const tasks: TodoTask[] = [
	{ id: "1", title: "补上扩展的网页渲染", done: true },
	{ id: "2", title: "给市场加“PiWeb 适配”徽章", done: false },
	{ id: "3", title: "写一份改造说明", done: false },
];

export default function todoPanel(pi: ExtensionAPI) {
	pi.registerCommand("todo", {
		description: "待办面板（PiWeb 用网页渲染，终端用字符）",
		handler: async (_args, ctx) => {
			const web = piwebUi(ctx.ui);
			if (web) {
				// 网页：点一次回一条 action，改完状态重画，最多 20 轮防止卡住
				for (let round = 0; round < 20; round += 1) {
					const result = await web.web(buildTodoTree(tasks), { title: "待办", timeout: 120_000 });
					if (!result?.action) return;
					const id = result.action.replace(/^toggle:/, "");
					const task = tasks.find((entry) => entry.id === id);
					if (!task) return;
					task.done = !task.done;
				}
				return;
			}
			// 终端：原来的做法，一行没改
			await openTerminalPanel(ctx.ui, { render: (width) => renderTodoLines(tasks, width) }, { title: "待办" });
		},
	});
}
