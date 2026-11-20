// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SessionSidebar } from "@/components/SessionSidebar";
import { SettingsPanel } from "@/components/SettingsPanel";

vi.mock("@/lib/theme", async (original) => ({ ...(await original<typeof import("@/lib/theme")>()), applyPebrelTheme: () => {}, loadPebrelTheme: () => "dsh", loadThemeMode: () => "system" }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("resource navigation without built-in business extensions", () => {
	it("keeps generic resource controls but has no mandatory automation page", () => {
		const select = vi.fn();
		render(<SessionSidebar sessions={[{ path: "/sessions/a.jsonl", cwd: "/ws", name: "Session A", modified: new Date().toISOString(), created: new Date().toISOString(), messageCount: 1, firstMessage: "Session A", streaming: false }]}
			addedWorkspaces={["/ws"]} currentPath="/sessions/a.jsonl" groupBy="workspace" orderBy="updated" setGroupBy={vi.fn()} setOrderBy={vi.fn()} collapsed={false}
			onToggleCollapse={vi.fn()} onOpen={vi.fn()} onNew={vi.fn()} onNewInWorkspace={vi.fn()} onRename={vi.fn(async () => {})} onOpenSettings={vi.fn()} onAddWorkspace={vi.fn()} activeView="plugins" onSelectView={select} />);
		expect(screen.getByRole("button", { name: "技能" })).toBeTruthy();
		expect(screen.getByRole("button", { name: /^(?:插件|扩展)$/ }).getAttribute("data-active")).toBe("true");
		expect(screen.queryByRole("button", { name: "自动化任务" })).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "技能" })); expect(select).toHaveBeenCalledWith("skills");
		fireEvent.click(screen.getByRole("button", { name: /^(?:插件|扩展)$/ })); expect(select).toHaveBeenCalledWith("plugins");
	});
	it("keeps application settings separate from resource installation", () => {
		vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ success: true, data: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 10000 }, compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 } } }) })));
		render(<SettingsPanel open onClose={vi.fn()} />);
		expect(screen.getByRole("button", { name: "通用设置" })).toBeTruthy(); expect(screen.getByRole("button", { name: "模型" })).toBeTruthy();
		expect(screen.queryByRole("button", { name: "技能" })).toBeNull(); expect(screen.queryByRole("button", { name: /^(?:插件|扩展)$/ })).toBeNull();
	});
});
