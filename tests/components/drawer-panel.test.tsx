// @vitest-environment jsdom
/**
 * 右侧抽屉的入口条与「导入会话」标题行。
 *
 * - 改前入口按钮用 onMouseEnter/Leave 直接改 style.background：悬停时点下去这一项变成选中，
 *   移开时「选中就不复原」，底色永远留在上面，之后切到别的入口也还在。
 * - 改前「导入会话」的标题行写的是「右侧抽屉」，还摆在入口条上面；别的入口的标题行都在入口条下面。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { DrawerPanel, type DrawerSection } from "@/components/DrawerPanel";
import type { GrowthApi } from "@/hooks/useGrowth";

vi.mock("@/components/PromptPanel", () => ({ PromptPanel: () => <div>prompts</div> }));
vi.mock("@/components/GitPanel", () => ({ GitPanel: () => <div>git</div> }));
vi.mock("@/components/ProjectPanel", () => ({ ProjectPanel: () => <div>project</div> }));
vi.mock("@/components/SessionImportSection", () => ({ SessionImportSection: () => <div>import-body</div> }));

afterEach(cleanup);

function Harness({ initial }: { initial: DrawerSection }) {
	const [section, setSection] = useState<DrawerSection>(initial);
	return (
		<DrawerPanel
			cwd="/w"
			section={section}
			onSectionChange={setSection}
			onClose={() => {}}
			sessionId={null}
			growth={{} as GrowthApi}
			workspaceName="w"
			hasSession={false}
			onOpenFileNode={() => {}}
			onError={() => {}}
		/>
	);
}

describe("drawer panel", () => {
	it("leaves no hover background behind after clicking a tab", () => {
		render(<Harness initial="project" />);
		const git = screen.getByTestId("drawer-entry-git");
		fireEvent.mouseEnter(git);
		fireEvent.click(git);
		fireEvent.mouseLeave(git);
		fireEvent.click(screen.getByTestId("drawer-entry-import"));
		for (const id of ["project", "prompts", "git", "import"]) {
			expect(screen.getByTestId(`drawer-entry-${id}`).style.background, id).toBe("");
		}
	});

	it("titles the import section below the tab strip like the other panels", () => {
		render(<Harness initial="import" />);
		expect(screen.queryByText("右侧抽屉")).toBeNull();
		const title = screen.getByText("导入会话");
		const tabs = screen.getByRole("tablist");
		// 标题在入口条之后
		expect(tabs.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		expect(screen.getByText("import-body")).toBeTruthy();
	});
});
