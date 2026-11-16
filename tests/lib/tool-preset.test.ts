/**
 * 档位 id 的归一化与工具白名单。
 *
 * 两件事必须钉住，否则「工作区内修改」会静默退化成旧的「常规编辑」：
 *   1. 旧值 `standard`（localStorage / web-tool-preferences.json / 自动化任务里都可能残留）
 *      读进来要变成 workspace，而不是被当成非法值丢掉再兜底成默认；
 *   2. workspace 档的工具名单里不能出现 bash / manage_automation。
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_TOOL_PRESET, TOOL_PRESET_IDS, isToolPreset, normalizeToolPreset } from "@/lib/tool-preset";
import { presetAllowsTool } from "@/lib/pi";
import { permissionDenial } from "@/lib/permission-gate";

describe("normalizeToolPreset", () => {
	it("maps the legacy `standard` id to workspace", () => {
		expect(normalizeToolPreset("standard")).toBe("workspace");
	});

	it("keeps the three current ids", () => {
		for (const id of TOOL_PRESET_IDS) expect(normalizeToolPreset(id), id).toBe(id);
		expect(DEFAULT_TOOL_PRESET).toBe("full");
	});

	it("rejects anything else instead of silently defaulting", () => {
		for (const value of ["", "STANDARD", "readOnly", "workspace-write", "full ", null, undefined, 1, {}]) {
			expect(normalizeToolPreset(value), String(value)).toBeUndefined();
			expect(isToolPreset(value), String(value)).toBe(false);
		}
	});
});

describe("presetAllowsTool", () => {
	it("offers bash in the workspace tier (它只在有沙箱后端时可用)", () => {
		expect(presetAllowsTool("workspace", "bash")).toBe(true);
		expect(presetAllowsTool("workspace", "powershell")).toBe(false);
		expect(presetAllowsTool("workspace", "manage_automation")).toBe(false);
		expect(presetAllowsTool("workspace", "write")).toBe(true);
		expect(presetAllowsTool("workspace", "edit")).toBe(true);
	});

	it("keeps the read-only tier free of writers but allows the sandboxed shell", () => {
		for (const name of ["write", "edit", "codemode", "manage_automation"]) {
			expect(presetAllowsTool("readonly", name), name).toBe(false);
		}
		for (const name of ["read", "grep", "find", "ls", "ask_user_question"]) {
			expect(presetAllowsTool("readonly", name), name).toBe(true);
		}
		// bash 在只读档是「只读沙箱」：命令能跑，写全被内核拒；没有沙箱后端时由运行时检查剔除
		expect(presetAllowsTool("readonly", "bash")).toBe(true);
	});

	it("offers MCP candidates and checks their read-only annotation at execution", async () => {
		expect(presetAllowsTool("readonly", "mcp__fs__write_file")).toBe(true);
		expect(presetAllowsTool("workspace", "mcp__fs__write_file")).toBe(true);
		expect(presetAllowsTool("workspace", "mcp__docs__search")).toBe(true);
		expect(presetAllowsTool("full", "anything_at_all")).toBe(true);
		for (const preset of ["readonly", "workspace"] as const) {
			expect(await permissionDenial({ preset, cwd: ".", toolName: "mcp__fs__write_file", input: {} })).toMatchObject({ block: true });
			expect(await permissionDenial({ preset, cwd: ".", toolName: "mcp__docs__search", input: {}, readOnlyHint: true })).toBeUndefined();
		}
	});
});
