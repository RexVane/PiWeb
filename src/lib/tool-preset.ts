/**
 * tool-preset：权限档位的 id 与旧值归一化（纯函数，浏览器与服务端共用）。
 *
 * 三档语义（id 是稳定契约，UI 文案可以改，id 不要改）：
 *   readonly  仅可查看     —— 只能读和搜索；有 OS 沙箱时允许只读 bash，桥层另外硬挡任何改盘调用
 *   workspace 工作区内修改 —— 可以改文件，写入路径必须在工作区或 extraRoots 内（realpath 校验）；
 *                             有 OS 沙箱时允许受限 bash（写入同样被内核关在工作区），否则不提供 shell；
 *                             详见 docs/workspace-isolation.md
 *   full      完全权限     —— 不限制
 *
 * `standard` 是 0.3.31 之前的中间档名字，当时只是「多开了 write/edit/bash 三个工具」，
 * 没有路径约束。它已经不在 id 列表里：localStorage、web-tool-preferences.json、
 * 自动化任务里残留的 `standard` 一律归一成 `workspace`（读的时候转，写回去只有新 id）。
 */
import type { ToolPreset } from "./types";

export const TOOL_PRESET_IDS = ["readonly", "workspace", "full"] as const;

export const TOOL_PRESET_LABELS: Record<ToolPreset, string> = {
	readonly: "仅可查看",
	workspace: "工作区内修改",
	full: "完全权限",
};

export function toolPresetLabel(preset: ToolPreset): string {
	return TOOL_PRESET_LABELS[preset];
}

export const DEFAULT_TOOL_PRESET: ToolPreset = "workspace";

export function isToolPreset(value: unknown): value is ToolPreset {
	return value === "readonly" || value === "workspace" || value === "full";
}

/** 读盘/读 localStorage 的入口：容忍旧的 `standard`，其它值返回 undefined 由调用方决定兜底 */
export function normalizeToolPreset(value: unknown): ToolPreset | undefined {
	if (value === "standard") return "workspace";
	return isToolPreset(value) ? value : undefined;
}
