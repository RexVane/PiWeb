// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { SessionSidebar } from "@/components/SessionSidebar";

type Props = Parameters<typeof SessionSidebar>[0];
const session: Props["sessions"][number] = {
	path: "/session", cwd: "/workspace", name: "Session", created: "2026-09-24T00:00:00Z",
	modified: "2026-09-24T00:00:00Z", messageCount: 1, firstMessage: "Hello", streaming: false,
};

beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function mount(overrides: Partial<Props> = {}) {
	const props: Props = {
		sessions: [session], addedWorkspaces: ["/workspace"], currentPath: "/session",
		groupBy: "workspace", orderBy: "updated", setGroupBy: vi.fn(), setOrderBy: vi.fn(),
		collapsed: false, onToggleCollapse: vi.fn(), onOpen: vi.fn(), onNew: vi.fn(),
		onNewInWorkspace: vi.fn(), onRename: vi.fn(async () => {}), onOpenSettings: vi.fn(),
		onAddWorkspace: vi.fn(), ...overrides,
	};
	render(<SessionSidebar {...props} />);
	return props;
}

it("keeps the workspace rename dialog and input when the request fails", async () => {
	const onRenameWorkspace = vi.fn(async () => { throw new Error("rename unavailable"); });
	mount({ onRenameWorkspace });
	fireEvent.click(screen.getByRole("button", { name: /工作区操作|Workspace actions/ }));
	fireEvent.click(screen.getByRole("button", { name: /^重命名$|^Rename$/ }));
	const dialog = await screen.findByRole("dialog");
	expect(dialog.classList.contains("glass-modal")).toBe(true);
	expect(dialog.parentElement?.classList.contains("modal-mask")).toBe(true);
	fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "New workspace" } });
	fireEvent.click(within(dialog).getByRole("button", { name: /^重命名$|^Rename$/ }));
	await waitFor(() => expect(within(dialog).getByRole("alert").textContent).toContain("rename unavailable"));
	expect(within(dialog).getByRole("textbox")).toHaveProperty("value", "New workspace");
	expect(onRenameWorkspace).toHaveBeenCalledWith("/workspace", "New workspace");
});

it("keeps the workspace removal confirmation open when the request fails", async () => {
	const onDeleteWorkspace = vi.fn(async () => { throw new Error("remove unavailable"); });
	mount({ onDeleteWorkspace });
	fireEvent.click(screen.getByRole("button", { name: /工作区操作|Workspace actions/ }));
	fireEvent.click(screen.getByRole("button", { name: /删除工作区|Remove workspace/ }));
	const dialog = await screen.findByRole("dialog");
	expect(dialog.classList.contains("glass-modal")).toBe(true);
	expect(dialog.parentElement?.classList.contains("modal-mask")).toBe(true);
	fireEvent.click(within(dialog).getByRole("button", { name: /删除工作区|Remove workspace/ }));
	await waitFor(() => expect(within(dialog).getByRole("alert").textContent).toContain("remove unavailable"));
	expect(onDeleteWorkspace).toHaveBeenCalledWith("/workspace");
});

it("archives from the session menu without opening the session", async () => {
	const onArchive = vi.fn();
	const onOpen = vi.fn();
	mount({ onArchive, onOpen });
	await screen.findByRole("button", { name: "Session" });
	fireEvent.click(screen.getByRole("button", { name: /会话操作|Session actions/ }));
	fireEvent.click(screen.getByRole("button", { name: /归档会话|Archive session/ }));
	expect(onArchive).toHaveBeenCalledWith("/session");
	expect(onOpen).not.toHaveBeenCalled();
});
