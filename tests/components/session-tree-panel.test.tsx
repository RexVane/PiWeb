// @vitest-environment jsdom
/** 会话分支面板：列出每一问、跳转 / 切分支、打标签 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SessionTreePanel } from "@/components/SessionTreePanel";
import type { SessionTreeNode } from "@/lib/session-tree";

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

const node = (overrides: Partial<SessionTreeNode> & Pick<SessionTreeNode, "entryId" | "text">): SessionTreeNode => ({
	ts: 1, indent: 0, forked: false, active: true, current: false, leafId: "a3", branches: 1, ...overrides,
});
const nodes: SessionTreeNode[] = [
	node({ entryId: "u1", text: "第一问", branches: 2 }),
	node({ entryId: "u2", text: "旧的第二问", indent: 1, forked: true, active: false, leafId: "a2", branches: 0, label: "回滚点" }),
	node({ entryId: "u2b", text: "新的第二问", indent: 1, forked: true, current: true, branches: 0, otherLabels: ["终稿"] }),
];

function stubTree(data: unknown = { nodes, leafId: "a3", truncated: false }) {
	const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ success: true, data }) }));
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

function renderPanel(overrides: Partial<Parameters<typeof SessionTreePanel>[0]> = {}) {
	const props = {
		sessionId: "session-1",
		onJump: vi.fn(),
		onSwitch: vi.fn(async () => true),
		onSetLabel: vi.fn(async () => true),
		onClose: vi.fn(),
		...overrides,
	};
	render(<SessionTreePanel {...props} />);
	return props;
}

describe("SessionTreePanel", () => {
	it("每一问一行：标出当前位置、分叉起点、不在当前分支上的，以及标签", async () => {
		const fetchMock = stubTree();
		renderPanel();
		const current = await screen.findByRole("button", { name: "新的第二问" });
		expect(fetchMock).toHaveBeenCalledWith("/api/agent/session-1/tree");
		expect(current.getAttribute("aria-current")).toBe("true");
		const rows = screen.getAllByRole("listitem");
		expect(rows.map((row) => [row.dataset.active ?? "false", row.dataset.forked ?? "false", row.dataset.current ?? "false"])).toEqual([
			["true", "false", "false"],
			["false", "true", "false"],
			["true", "true", "true"],
		]);
		// 分叉点标出后面有几条分支；提问自己的标签和这一问之内的标签都显示
		expect(rows[0].textContent).toContain("×2");
		expect(rows[1].textContent).toContain("回滚点");
		expect(rows[2].textContent).toContain("终稿");
	});

	it("点当前分支上的提问跳到对话里，点别的分支上的提问切过去并重新拉树", async () => {
		const fetchMock = stubTree();
		const props = renderPanel();
		fireEvent.click(await screen.findByRole("button", { name: "第一问" }));
		expect(props.onJump).toHaveBeenCalledWith("u1");
		expect(props.onSwitch).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole("button", { name: "旧的第二问" }));
		// 切分支是把叶子挪到那条分支最新的位置，不是挪到这一问本身
		await waitFor(() => expect(props.onSwitch).toHaveBeenCalledWith("a2"));
		await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
		expect(props.onJump).toHaveBeenCalledTimes(1);
	});

	it("pi 正在跑的时候不切分支，并说明原因；跳转照常可用", async () => {
		stubTree();
		const props = renderPanel({ running: true });
		const other = await screen.findByRole("button", { name: "旧的第二问" });
		expect(screen.getByText(/结束后才能切换分支/)).toBeTruthy();
		expect(other.getAttribute("aria-disabled")).toBe("true");
		fireEvent.click(other);
		expect(props.onSwitch).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "第一问" }));
		expect(props.onJump).toHaveBeenCalledWith("u1");
	});

	it("图钉打标签：回车保存，Esc 取消，没改就不发请求", async () => {
		stubTree();
		const props = renderPanel();
		fireEvent.click(await screen.findByRole("button", { name: "加标签：第一问" }));
		const input = screen.getByRole("textbox", { name: "标签" }) as HTMLInputElement;
		fireEvent.change(input, { target: { value: "  里程碑 " } });
		fireEvent.keyDown(input, { key: "Enter" });
		await waitFor(() => expect(props.onSetLabel).toHaveBeenCalledWith("u1", "里程碑"));

		// 已有标签：输入框带着原值；Esc 不保存
		fireEvent.click(screen.getByRole("button", { name: "改标签：旧的第二问" }));
		const edit = screen.getByRole("textbox", { name: "标签" }) as HTMLInputElement;
		expect(edit.value).toBe("回滚点");
		fireEvent.change(edit, { target: { value: "别的名字" } });
		fireEvent.keyDown(edit, { key: "Escape" });
		expect(screen.queryByRole("textbox", { name: "标签" })).toBeNull();
		// 原样回车不发请求；清空则是清掉标签
		fireEvent.click(screen.getByRole("button", { name: "改标签：旧的第二问" }));
		fireEvent.keyDown(screen.getByRole("textbox", { name: "标签" }), { key: "Enter" });
		expect(props.onSetLabel).toHaveBeenCalledTimes(1);
		fireEvent.click(screen.getByRole("button", { name: "改标签：旧的第二问" }));
		const clear = screen.getByRole("textbox", { name: "标签" });
		fireEvent.change(clear, { target: { value: "" } });
		fireEvent.keyDown(clear, { key: "Enter" });
		await waitFor(() => expect(props.onSetLabel).toHaveBeenLastCalledWith("u2", ""));
	});

	it("没有打开会话、会话没有提问、读取失败、提问太多，各有一句说明", async () => {
		const noSession = vi.fn();
		vi.stubGlobal("fetch", noSession);
		renderPanel({ sessionId: null });
		expect(screen.getByText("打开一个会话后，这里显示它的分支。")).toBeTruthy();
		expect(noSession).not.toHaveBeenCalled();
		cleanup();

		stubTree({ nodes: [], leafId: null, truncated: false });
		renderPanel();
		expect(await screen.findByText("这个会话还没有提问。")).toBeTruthy();
		cleanup();

		vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 400, json: async () => ({ success: false, error: "session not found" }) })));
		renderPanel();
		expect((await screen.findByRole("alert")).textContent).toContain("session not found");
		cleanup();

		stubTree({ nodes, leafId: "a3", truncated: true });
		renderPanel();
		expect(await screen.findByText("提问太多，只列出前 3 个。")).toBeTruthy();
	});

	it("换会话或刷新键变了就重新拉", async () => {
		const fetchMock = stubTree();
		const props = { sessionId: "session-1", onJump: vi.fn(), onSwitch: vi.fn(async () => true), onSetLabel: vi.fn(async () => true), onClose: vi.fn() };
		const { rerender } = render(<SessionTreePanel {...props} refreshKey="a" />);
		await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
		rerender(<SessionTreePanel {...props} refreshKey="b" />);
		await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
		rerender(<SessionTreePanel {...props} sessionId="session-2" refreshKey="b" />);
		await waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith("/api/agent/session-2/tree"));
	});

	it("切换会话后不再显示或操作上一份会话的树，即使新树仍在读取", async () => {
		let finishNext!: (data: unknown) => void;
		const fetchMock = stubTree();
		const props = { sessionId: "session-1", onJump: vi.fn(), onSwitch: vi.fn(async () => true), onSetLabel: vi.fn(async () => true), onClose: vi.fn() };
		const { rerender } = render(<SessionTreePanel {...props} />);
		await screen.findByRole("button", { name: "第一问" });
		fetchMock.mockImplementationOnce(() => new Promise((resolve) => {
			finishNext = (data) => resolve({ ok: true, status: 200, json: async () => ({ success: true, data }) });
		}));
		rerender(<SessionTreePanel {...props} sessionId="session-2" />);
		expect(screen.queryByRole("button", { name: "第一问" })).toBeNull();
		expect(screen.queryByRole("button", { name: "旧的第二问" })).toBeNull();
		await act(async () => finishNext({ nodes: [node({ entryId: "other", text: "另一份会话" })], leafId: "other", truncated: false }));
		expect(await screen.findByRole("button", { name: "另一份会话" })).toBeTruthy();
	});

	it.each(["switch", "label"] as const)("换会话后，旧的 %s 操作完成时不再刷新旧树", async (action) => {
		let finishAction!: (success: boolean) => void;
		const pending = new Promise<boolean>((resolve) => { finishAction = resolve; });
		const fetchMock = stubTree();
		const props = { sessionId: "session-1", onJump: vi.fn(), onSwitch: vi.fn(() => pending), onSetLabel: vi.fn(() => pending), onClose: vi.fn() };
		const { rerender } = render(<SessionTreePanel {...props} />);
		await screen.findByRole("button", { name: "第一问" });
		if (action === "switch") fireEvent.click(screen.getByRole("button", { name: "旧的第二问" }));
		else {
			fireEvent.click(screen.getByRole("button", { name: "加标签：第一问" }));
			const input = screen.getByRole("textbox", { name: "标签" });
			fireEvent.change(input, { target: { value: "新标签" } });
			fireEvent.keyDown(input, { key: "Enter" });
		}
		fetchMock.mockImplementationOnce(async () => ({ ok: true, status: 200, json: async () => ({ success: true, data: { nodes: [node({ entryId: "other", text: "另一份会话" })] } }) }));
		rerender(<SessionTreePanel {...props} sessionId="session-2" />);
		await screen.findByRole("button", { name: "另一份会话" });
		await act(async () => finishAction(true));
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(screen.queryByRole("button", { name: "第一问" })).toBeNull();
		expect(screen.getByRole("button", { name: "另一份会话" })).toBeTruthy();
	});
});
