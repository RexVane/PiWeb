// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionSidebar } from "@/components/SessionSidebar";

afterEach(cleanup);

describe("prompt template sidebar navigation", () => {
	it.each([false, true])("offers template management with the sidebar collapsed=%s", (collapsed) => {
		const onSelectView = vi.fn();
		const { container } = render(<SessionSidebar sessions={[]} addedWorkspaces={[]} currentPath={null} groupBy="workspace" orderBy="updated"
			setGroupBy={vi.fn()} setOrderBy={vi.fn()} collapsed={collapsed} onToggleCollapse={vi.fn()} onOpen={vi.fn()} onNew={vi.fn()}
			onNewInWorkspace={vi.fn()} onRename={vi.fn(async () => {})} onOpenSettings={vi.fn()} onAddWorkspace={vi.fn()} activeView="prompts" onSelectView={onSelectView} />);
		const templates = screen.getByRole("button", { name: "提示词模板" });
		fireEvent.click(templates);
		expect(onSelectView).toHaveBeenCalledWith("prompts");
		const buttons = [...container.querySelectorAll<HTMLElement>("button")];
		expect(buttons.indexOf(templates)).toBeGreaterThan(buttons.indexOf(screen.getByRole("button", { name: "扩展" })));
		if (!collapsed) expect(templates.getAttribute("data-active")).toBe("true");
	});
});
