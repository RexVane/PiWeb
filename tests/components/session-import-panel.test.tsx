// @vitest-environment jsdom
/**
 * 导入会话面板：默认一条都不勾（本机 ZCode 91 / opencode 643 条，一键全选就是事故），
 * 已导入的行必须禁用，导入结果按成功/跳过/失败给出来源与原因。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SessionImportSection } from "@/components/SessionImportSection";

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

function response(data: unknown) {
	return { ok: true, status: 200, json: async () => ({ success: true, data }) };
}

const session = (overrides: Record<string, unknown>) => ({
	source: "claude",
	externalId: "id",
	title: "标题",
	projectPath: "/ws",
	createdAt: Date.UTC(2026, 8, 13),
	updatedAt: Date.UTC(2026, 8, 13),
	messageCount: 4,
	...overrides,
});

function setup(options: { sessions?: unknown[]; imported?: string[]; archived?: string[]; workspace?: string; errors?: unknown[]; importResponse?: Promise<unknown> } = {}) {
	const posts: Array<{ url: string; body: unknown }> = [];
	const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
		if (url === "/api/sessions/import" && (!init || init.method !== "POST")) {
			return response({
				sessions: options.sessions ?? [
					session({ source: "claude", externalId: "c1", title: "Claude 的会话" }),
					session({ source: "zcode", externalId: "z1", title: "ZCode 的会话", projectPath: "D:\\AIApp\\PiWeb" }),
					session({ source: "zcode", externalId: "z2", title: "已经导过的", messageCount: undefined }),
				],
				errors: options.errors ?? [],
				imported: options.imported ?? ["zcode:z2"],
				archived: options.archived ?? [],
				sources: ["claude", "codex", "grok", "zcode", "dsh", "opencode"],
			});
		}
		if (url === "/api/sessions/import" && init?.method === "POST") {
			posts.push({ url, body: JSON.parse(String(init.body)) });
			if (options.importResponse) return options.importResponse;
			return response({
				imported: 1,
				skipped: 1,
				failed: 1,
				results: [
					{ source: "claude", externalId: "c1", title: "Claude 的会话", status: "imported", messageCount: 12, workspace: "/ws" },
					{ source: "zcode", externalId: "z1", title: "ZCode 的会话", status: "skipped", reason: "已经导入过" },
					{ source: "dsh", externalId: "d1", title: "dsh 的会话", status: "failed", reason: "源会话已不存在" },
				],
				workspaces: ["/ws"],
			});
		}
		if (url === "/api/workspaces") return response({ workspaces: ["/ws", options.workspace ?? "D:\\AIApp\\PiWeb"] });
		throw new Error(`unexpected URL ${url}`);
	});
	vi.stubGlobal("fetch", fetchMock);
	render(<SessionImportSection cwd="/ws" />);
	return { fetchMock, posts };
}

describe("导入会话面板", () => {
	it("已归档的会话可选择恢复，普通已导入会话仍然禁用", async () => {
		const options = { archived: ["zcode:z2"], importResponse: Promise.resolve(response({ imported: 0, restored: 1, skipped: 0, failed: 0, results: [{ source: "zcode", externalId: "z2", status: "restored", workspace: "/ws" }], workspaces: ["/ws"] })) };
		const { posts } = setup(options);
		fireEvent.click(await screen.findByTestId("import-source-zcode"));
		const row = screen.getByText("已经导过的").closest("label")!;
		expect(row.textContent).toContain("已归档");
		expect(row.textContent).toContain("保留在 Pi 中新增的内容");
		fireEvent.click(row.querySelector("input")!);
		const run = screen.getByTestId("import-run");
		expect(run.textContent).toContain("恢复所选 (1)");
		options.archived = [];
		fireEvent.click(run);
		const report = await screen.findByTestId("import-report");
		expect(report.textContent).toContain("已恢复 1 条归档会话");
		expect(report.textContent).toContain("已经导过的");
		await waitFor(() => expect((screen.getByText("已经导过的", { selector: "strong[title]" }).closest("label")!.querySelector("input") as HTMLInputElement).disabled).toBe(true));
		expect(posts[0].body).toMatchObject({ sessions: [{ source: "zcode", externalId: "z2" }] });
	});

	it("搜索标题、项目和模型，只全选当前可见结果，隐藏的选择仍保留", async () => {
		const { posts } = setup({ imported: [], sessions: [
			session({ externalId: "login", title: "完成登录页", projectPath: "/work/web-app", model: "model-a" }),
			session({ externalId: "api", title: "接口校验", projectPath: "/work/server", model: "model-b" }),
		] });
		fireEvent.click((await screen.findByText("接口校验")).closest("label")!.querySelector("input")!);
		fireEvent.change(screen.getByRole("searchbox"), { target: { value: "web-app" } });
		expect(screen.queryByText("接口校验")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "全选结果" }));
		expect(screen.getByTestId("import-run").textContent).toContain("(2)");
		fireEvent.change(screen.getByRole("searchbox"), { target: { value: "model-b" } });
		expect(screen.getByText("接口校验")).toBeTruthy();
		expect(screen.queryByText("完成登录页")).toBeNull();
		fireEvent.change(screen.getByRole("searchbox"), { target: { value: "no match" } });
		expect(screen.getByText("没有匹配的会话")).toBeTruthy();
		fireEvent.click(screen.getByText("清空搜索"));
		fireEvent.click(screen.getByTestId("import-run"));
		await waitFor(() => expect(posts).toHaveLength(1));
		expect(posts[0].body).toMatchObject({ sessions: [{ source: "claude", externalId: "login" }, { source: "claude", externalId: "api" }] });
	});

	it("重新扫描会移除消失或已导入的选择，并保留仍可导入的选择", async () => {
		const options = { imported: [] as string[], sessions: [session({ externalId: "a" }), session({ externalId: "b" }), session({ externalId: "c" })] };
		const { posts } = setup(options);
		await screen.findByTestId("import-group-claude");
		fireEvent.click(screen.getByRole("button", { name: "全选本组" }));
		expect(screen.getByTestId("import-run").textContent).toContain("(3)");
		options.sessions = [session({ externalId: "a" }), session({ externalId: "b" })];
		options.imported = ["claude:a"];
		fireEvent.click(screen.getByTestId("import-rescan"));
		await waitFor(() => expect(screen.getByTestId("import-run").textContent).toContain("(1)"));
		fireEvent.click(screen.getByTestId("import-run"));
		await waitFor(() => expect(posts).toHaveLength(1));
		expect(posts[0].body).toMatchObject({ sessions: [{ source: "claude", externalId: "b" }] });
	});

	it("导入期间锁定选择与去向并防止重复导入", async () => {
		let resolve!: (value: unknown) => void;
		const importResponse = new Promise((yes) => { resolve = yes; });
		const { posts } = setup({ importResponse });
		fireEvent.click((await screen.findByText("Claude 的会话")).closest("label")!.querySelector("input")!);
		fireEvent.click(screen.getByTestId("import-run"));
		fireEvent.click(screen.getByTestId("import-run"));
		await waitFor(() => expect(posts).toHaveLength(1));
		expect((screen.getByTestId("import-rescan") as HTMLButtonElement).disabled).toBe(true);
		expect((screen.getByTestId("import-fallback") as HTMLSelectElement).disabled).toBe(true);
		expect((screen.getByRole("checkbox") as HTMLInputElement).disabled).toBe(true);
		expect((screen.getByRole("searchbox") as HTMLInputElement).disabled).toBe(true);
		resolve(response({ imported: 1, skipped: 0, failed: 0, results: [], workspaces: [] }));
		await screen.findByTestId("import-report");
	});

	it("来源页签支持方向键切换", async () => {
		setup();
		const claude = await screen.findByTestId("import-source-claude");
		fireEvent.keyDown(claude, { key: "ArrowRight" });
		expect(screen.getByTestId("import-source-zcode").getAttribute("aria-selected")).toBe("true");
		expect(screen.getByTestId("import-group-zcode")).toBeTruthy();
	});

	it("一次只列一个来源，默认落在第一个有会话的来源上，且默认一条都不勾选", async () => {
		setup();
		const claudeGroup = await screen.findByTestId("import-group-claude");
		expect(claudeGroup.textContent).toContain("Claude 的会话");
		// 其它来源的会话不铺在这一屏里
		expect(screen.queryByTestId("import-group-zcode")).toBeNull();
		expect(screen.queryByText("ZCode 的会话")).toBeNull();

		const checkboxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
		expect(checkboxes).toHaveLength(1); // 只渲染当前来源的行
		expect(checkboxes.every((box) => !box.checked)).toBe(true);
		// 没勾选时导入按钮禁用
		expect((screen.getByTestId("import-run") as HTMLButtonElement).disabled).toBe(true);
	});

	it("选择器列出所有有会话的来源并带条数，切换后只显示该来源", async () => {
		setup();
		const tabs = await screen.findByTestId("import-source-tabs");
		expect(tabs.textContent).toContain("Claude Code");
		expect(tabs.textContent).toContain("ZCode");

		fireEvent.click(screen.getByTestId("import-source-zcode"));
		expect((await screen.findByTestId("import-group-zcode")).textContent).toContain("ZCode 的会话");
		expect(screen.queryByText("Claude 的会话")).toBeNull();

		// 选中的来源高亮（aria-selected 供读屏与测试共用）
		expect(screen.getByTestId("import-source-zcode").getAttribute("aria-selected")).toBe("true");
		expect(screen.getByTestId("import-source-claude").getAttribute("aria-selected")).toBe("false");
	});

	it("切换来源不会丢掉另一个来源上已勾选的行", async () => {
		const { posts } = setup();
		fireEvent.click((await screen.findByText("Claude 的会话")).closest("label")?.querySelector("input") as HTMLInputElement);
		fireEvent.click(screen.getByTestId("import-source-zcode"));
		fireEvent.click((await screen.findByText("ZCode 的会话")).closest("label")?.querySelector("input") as HTMLInputElement);

		// 两个来源各勾了一条，按钮计数是合计
		expect(screen.getByTestId("import-run").textContent).toContain("(2)");
		fireEvent.click(screen.getByTestId("import-run"));
		await waitFor(() => expect(posts).toHaveLength(1));
		expect(posts[0].body).toEqual({ sessions: [{ source: "claude", externalId: "c1" }, { source: "zcode", externalId: "z1" }], fallbackCwd: "/ws" });
	});

	it("已导入的行被禁用并标出来，来源统计里也计入", async () => {
		setup();
		fireEvent.click(await screen.findByTestId("import-source-zcode"));
		const importedRow = await screen.findByText("已经导过的");
		const checkbox = importedRow.closest("label")?.querySelector("input") as HTMLInputElement;
		expect(checkbox.disabled).toBe(true);
		expect(importedRow.closest("label")?.textContent).toContain("已导入");
		expect(screen.getByTestId("import-group-zcode").textContent).toMatch(/2 条 · 已导入 1/);
	});

	it("勾选后按钮显示条数，导入请求只带 source 与 externalId（不带任何路径）", async () => {
		const { posts } = setup();
		const row = await screen.findByText("Claude 的会话");
		fireEvent.click(row.closest("label")?.querySelector("input") as HTMLInputElement);

		const run = await screen.findByTestId("import-run");
		expect(run.textContent).toContain("(1)");
		fireEvent.click(run);

		await waitFor(() => expect(posts).toHaveLength(1));
		expect(posts[0].body).toEqual({ sessions: [{ source: "claude", externalId: "c1" }], fallbackCwd: "/ws" });
	});

	it("结果条给出成功/跳过/失败，并列出失败原因", async () => {
		setup();
		fireEvent.click((await screen.findByText("Claude 的会话")).closest("label")?.querySelector("input") as HTMLInputElement);
		fireEvent.click(screen.getByTestId("import-run"));

		const report = await screen.findByTestId("import-report");
		expect(report.textContent).toContain("成功 1 · 跳过 1 · 失败 1");
		expect(report.textContent).toContain("已经导入过");
		expect(report.textContent).toContain("源会话已不存在");
		// 导入后面板重新扫描，并把选择清空
		await waitFor(() => expect((screen.getByTestId("import-run") as HTMLButtonElement).disabled).toBe(true));
	});

	it("全选只作用于当前来源，且跳过已导入的行", async () => {
		const { posts } = setup();
		fireEvent.click((await screen.findByText("Claude 的会话")).closest("label")?.querySelector("input") as HTMLInputElement); // 先勾一条别的来源的
		fireEvent.click(await screen.findByTestId("import-source-zcode"));
		const selectAll = await screen.findByText("全选本组");
		fireEvent.click(selectAll);

		// zcode 这一组只有 z1 可勾（z2 已导入），再加上前面那条 claude 的
		expect(screen.getByTestId("import-run").textContent).toContain("(2)");
		fireEvent.click(screen.getByTestId("import-run"));
		await waitFor(() =>
			expect(posts[0].body).toEqual({ sessions: [{ source: "claude", externalId: "c1" }, { source: "zcode", externalId: "z1" }], fallbackCwd: "/ws" }),
		);
	});

	it("兜底工作区是可选项且默认为当前工作区，不允许手输", async () => {
		setup();
		const select = (await screen.findByTestId("import-fallback")) as HTMLSelectElement;
		expect(select.tagName).toBe("SELECT");
		expect(select.value).toBe("/ws");
		await waitFor(() => expect(select.options).toHaveLength(2));
		expect(Array.from(select.options).map((option) => option.value)).toEqual(["/ws", "D:\\AIApp\\PiWeb"]);
	});

	it("某个来源扫描失败时给出提示，其余来源照常可选", async () => {
		setup({ sessions: [session({ source: "grok", externalId: "g1", title: "Grok 的会话" })], errors: [{ source: "opencode", message: "库被锁定" }] });
		expect(await screen.findByText(/opencode 扫描失败：库被锁定/)).toBeTruthy();
		expect(await screen.findByTestId("import-group-grok")).toBeTruthy();
	});
});
