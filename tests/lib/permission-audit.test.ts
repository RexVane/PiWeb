/**
 * 权限审计：写进会话 JSONL 的 custom entry。
 *
 * 三个断言：customType 固定、事件内容完整、**写失败不能影响命令执行**（审计是旁路）。
 */
import { describe, expect, it, vi } from "vitest";
import { appendPermissionAudit, PERMISSION_AUDIT_TYPE } from "@/lib/permission-audit";

describe("appendPermissionAudit", () => {
	it("appends a decision entry under the stable custom type", () => {
		const appendCustomEntry = vi.fn(() => "entry-1");
		const event = { kind: "decision" as const, approved: true, outcome: "approved" as const, scope: "full" as const, preset: "workspace" as const, reason: "需要写 worktree 的 .git", at: 1_700_000_000_000 };
		appendPermissionAudit({ appendCustomEntry }, event);
		expect(appendCustomEntry).toHaveBeenCalledWith(PERMISSION_AUDIT_TYPE, event);
		expect(PERMISSION_AUDIT_TYPE).toBe("piweb_permission");
	});

	it("records which command actually used the grant", () => {
		const appendCustomEntry = vi.fn(() => "entry-2");
		appendPermissionAudit({ appendCustomEntry }, { kind: "used", scope: "workspace", preset: "readonly", command: "git status", at: 1 });
		expect(appendCustomEntry).toHaveBeenCalledWith(PERMISSION_AUDIT_TYPE, expect.objectContaining({ kind: "used", command: "git status" }));
	});

	it("never throws when there is no session or the write fails", () => {
		expect(() => appendPermissionAudit(null, { kind: "used", scope: "full", preset: "full", command: "x", at: 1 })).not.toThrow();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		expect(() => appendPermissionAudit({ appendCustomEntry: () => { throw new Error("disk full"); } }, { kind: "used", scope: "full", preset: "full", command: "x", at: 1 })).not.toThrow();
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});
});
