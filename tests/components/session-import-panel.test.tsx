// @vitest-environment jsdom
/**
 * 导入会话面板：默认一条都不勾（本机 ZCode 91 / opencode 643 条，一键全选就是事故），
 * 已导入的行必须禁用，导入结果按成功/跳过/失败给出来源与原因。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { SessionImportSection } from "@/components/SessionImportSection";
import { INITIAL_SCAN_LIMIT, MAX_SCAN_LIMIT, MAX_IMPORT_SELECTION } from "@/lib/session-import/limits";

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

function setup(options: { sessions?: unknown[]; imported?: string[]; archived?: string[]; workspace?: string; errors?: unknown[]; importResponse?: Promise<unknown>; scanPages?: Record<number, unknown[]>; hasMore?: Record<string, boolean> } = {}) {
	const posts: Array<{ url: string; body: unknown }> = [];
	const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
		if (url.startsWith("/api/sessions/import") && (!init || init.method !== "POST")) {
			const limit = Number(new URL(url, "http://localhost").searchParams.get("limit") ?? INITIAL_SCAN_LIMIT);
			return response({
				sessions: options.scanPages?.[limit] ?? options.sessions ?? [
					session({ source: "claude", externalId: "c1", title: "Claude 的会话" }),
					session({ source: "zcode", externalId: "z1", title: "ZCode 的会话", projectPath: "D:\\AIApp\\PiWeb" }),
					session({ source: "zcode", externalId: "z2", title: "已经导过的", messageCount: undefined }),
				],
				errors: options.errors ?? [],
				imported: options.imported ?? ["zcode:z2"],
				archived: options.archived ?? [],
				sources: ["claude", "codex", "grok", "zcode", "dsh", "opencode"],
				limit,
				hasMore: options.hasMore ?? {},
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

async function openSources() {
	const trigger = await screen.findByTestId("import-source-picker");
	await waitFor(() => expect((trigger as HTMLButtonElement).disabled).toBe(false));
	fireEvent.click(trigger);
	return screen.getByRole("combobox", { name: "搜索来源名称或 ID" });
}

async function chooseSource(source: string) {
	await openSources();
	fireEvent.click(screen.getByTestId("import-source-" + source));
}

describe("导入会话面板", () => {
	it("项目与状态筛选可组合，跨来源已选项可统一检查，清除结果只影响可见项", async () => {
		setup({ imported: ["zcode:done"], sessions: [
			session({ externalId: "a", title: "网页修复", projectPath: "D:\\AIApp\\PiWeb" }),
			session({ externalId: "b", title: "另一个项目", projectPath: "/other" }),
			session({ source: "zcode", externalId: "c", title: "同项目旧会话", projectPath: "d:/aiapp/piweb/" }),
			session({ source: "zcode", externalId: "done", title: "已完成导入", projectPath: "D:\\AIApp\\PiWeb" }),
		] });
		await chooseSource("all");
		fireEvent.change(screen.getByRole("combobox", { name: "筛选项目" }), { target: { value: "d:/aiapp/piweb" } });
		fireEvent.change(screen.getByRole("combobox", { name: "筛选状态" }), { target: { value: "available" } });
		expect(screen.queryByText("另一个项目")).toBeNull();
		expect(screen.queryByText("已完成导入")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "全选结果" }));
		expect(screen.getByTestId("import-run").textContent).toContain("(2)");
		await chooseSource("claude");
		expect(screen.getByText("其中 1 条不在当前列表")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "取消选择结果" }));
		expect(screen.getByTestId("import-run").textContent).toContain("(1)");
		fireEvent.click(screen.getByRole("button", { name: "查看全部已选" }));
		expect(screen.getByTestId("import-group-all").textContent).toContain("同项目旧会话");
		expect(screen.queryByText("网页修复")).toBeNull();
		expect((screen.getByRole("combobox", { name: "筛选状态" }) as HTMLSelectElement).value).toBe("selected");
	});

	it("找不到旧会话时可扩大搜索范围，并在后续重新扫描时保留范围与已选项", async () => {
		const recent = Array.from({ length: INITIAL_SCAN_LIMIT }, (_, index) => session({ externalId: `recent-${index}`, title: `近期会话 ${index}` }));
		const options = { imported: [], scanPages: { [INITIAL_SCAN_LIMIT]: recent, [INITIAL_SCAN_LIMIT * 2]: [...recent, session({ externalId: "old", title: "更早的部署记录" })] }, hasMore: { claude: true } };
		const { fetchMock } = setup(options);
		fireEvent.click((await screen.findByText("近期会话 0")).closest("label")!.querySelector("input")!);
		fireEvent.change(screen.getByRole("searchbox"), { target: { value: "更早" } });
		expect(screen.getByText("没有匹配的会话")).toBeTruthy();
		options.hasMore.claude = false;
		fireEvent.click(screen.getByTestId("import-load-more"));
		const older = await screen.findByText("更早的部署记录");
		expect(fetchMock).toHaveBeenCalledWith(`/api/sessions/import?limit=${INITIAL_SCAN_LIMIT * 2}`);
		expect(screen.getByText("其中 1 条不在当前列表")).toBeTruthy();
		fireEvent.click(older.closest("label")!.querySelector("input")!);
		fireEvent.click(screen.getByTestId("import-rescan"));
		await waitFor(() => expect((screen.getByTestId("import-rescan") as HTMLButtonElement).disabled).toBe(false));
		expect(fetchMock.mock.calls.at(-1)?.[0]).toBe(`/api/sessions/import?limit=${INITIAL_SCAN_LIMIT * 2}`);
		expect(screen.getByTestId("import-run").textContent).toContain("(2)");
		expect(screen.queryByTestId("import-load-more")).toBeNull();
	});

	it("扩大扫描达到上限后说明范围，不再发起更大扫描", async () => {
		const { fetchMock } = setup({ hasMore: { claude: true } });
		await screen.findByTestId("import-group-claude");
		for (const limit of [100, 200, 400, 800, MAX_SCAN_LIMIT]) {
			fireEvent.click(screen.getByTestId("import-load-more"));
			await waitFor(() => expect((screen.getByTestId("import-rescan") as HTMLButtonElement).disabled).toBe(false));
			expect(fetchMock).toHaveBeenCalledWith(`/api/sessions/import?limit=${limit}`);
		}
		expect(screen.queryByTestId("import-load-more")).toBeNull();
		expect(screen.getByText(`每个来源最多查看最近 ${MAX_SCAN_LIMIT} 条会话`)).toBeTruthy();
	});

	it("跨来源批量选择最多 500 条，取消勾选后可更换最后一条", async () => {
		const { posts } = setup({ imported: [], sessions: Array.from({ length: MAX_IMPORT_SELECTION + 1 }, (_, index) => session({ source: index < 250 ? "claude" : "zcode", externalId: `bulk-${index}`, title: `批量会话 ${index}` })) });
		await chooseSource("all");
		fireEvent.click(screen.getByRole("button", { name: "全选本组" }));
		const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
		expect(boxes.filter((box) => box.checked)).toHaveLength(MAX_IMPORT_SELECTION);
		expect(boxes[MAX_IMPORT_SELECTION].disabled).toBe(true);
		expect(screen.getByText(`单次最多选择 ${MAX_IMPORT_SELECTION} 条，可分批导入`)).toBeTruthy();
		fireEvent.click(boxes[0]);
		fireEvent.click(boxes[MAX_IMPORT_SELECTION]);
		fireEvent.click(screen.getByTestId("import-run"));
		await waitFor(() => expect(posts).toHaveLength(1));
		const body = posts[0].body as { sessions: Array<{ externalId: string }> };
		expect(body.sessions).toHaveLength(MAX_IMPORT_SELECTION);
		expect(body.sessions.some((row) => row.externalId === "bulk-0")).toBe(false);
		expect(body.sessions.some((row) => row.externalId === `bulk-${MAX_IMPORT_SELECTION}`)).toBe(true);
	});

	it("已归档的会话可选择恢复，普通已导入会话仍然禁用", async () => {
		const options = { archived: ["zcode:z2"], importResponse: Promise.resolve(response({ imported: 0, restored: 1, skipped: 0, failed: 0, results: [{ source: "zcode", externalId: "z2", status: "restored", workspace: "/ws" }], workspaces: ["/ws"] })) };
		const { posts } = setup(options);
		await chooseSource("zcode");
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

	it("来源下拉支持搜索、键盘选择和 Escape 取消", async () => {
		setup();
		const input = await openSources();
		fireEvent.change(input, { target: { value: "code" } });
		expect(within(screen.getByRole("listbox")).getAllByRole("option").map((option) => option.textContent)).toEqual(expect.arrayContaining([expect.stringContaining("Codex"), expect.stringContaining("ZCode"), expect.stringContaining("opencode")]));
		fireEvent.keyDown(input, { key: "ArrowDown" });
		fireEvent.keyDown(input, { key: "ArrowDown" });
		fireEvent.keyDown(input, { key: "Enter" });
		expect(screen.getByTestId("import-group-zcode")).toBeTruthy();
		expect(screen.queryByRole("listbox")).toBeNull();
		const again = await openSources();
		fireEvent.change(again, { target: { value: "none" } });
		expect(screen.getByText("没有匹配的来源")).toBeTruthy();
		fireEvent.keyDown(again, { key: "Escape" });
		expect(screen.queryByRole("listbox")).toBeNull();
		expect(document.activeElement).toBe(screen.getByTestId("import-source-picker"));
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
		// 没勾选时不占用列表空间显示空的操作栏
		expect(screen.queryByTestId("import-run")).toBeNull();
		expect(screen.getByTestId("session-import").querySelector("footer")).toBeNull();
		expect(screen.queryByText("清空选择")).toBeNull();
	});

	it("下拉列出全部来源入口及六个来源和条数，空来源可查看，再扫描不重置选择", async () => {
		setup();
		await openSources();
		expect(within(screen.getByRole("listbox")).getAllByRole("option")).toHaveLength(7);
		expect(screen.getByTestId("import-source-zcode").textContent).toContain("2 条会话");
		expect(screen.getByTestId("import-source-codex").textContent).toContain("0 条会话");
		expect(screen.getByTestId("import-source-claude").getAttribute("aria-selected")).toBe("true");
		fireEvent.click(screen.getByTestId("import-source-codex"));
		expect(screen.getByTestId("import-group-codex").textContent).toContain("没有找到可导入的本地会话");
		expect(screen.queryByText("Claude 的会话")).toBeNull();
		fireEvent.click(screen.getByTestId("import-rescan"));
		await waitFor(() => expect((screen.getByTestId("import-rescan") as HTMLButtonElement).disabled).toBe(false));
		expect(screen.getByTestId("import-group-codex")).toBeTruthy();
		await openSources();
		fireEvent.mouseDown(document.body);
		expect(screen.queryByRole("listbox")).toBeNull();
	});

	it("没有会话时仍可查看全部支持来源", async () => {
		setup({ sessions: [] });
		await openSources();
		expect(within(screen.getByRole("listbox")).getAllByRole("option")).toHaveLength(7);
		fireEvent.click(screen.getByTestId("import-source-opencode"));
		expect(screen.getByTestId("import-group-opencode").textContent).toContain("没有找到可导入的本地会话");
	});

	it("切换来源不会丢掉另一个来源上已勾选的行", async () => {
		const { posts } = setup();
		fireEvent.click((await screen.findByText("Claude 的会话")).closest("label")?.querySelector("input") as HTMLInputElement);
		await chooseSource("zcode");
		fireEvent.click((await screen.findByText("ZCode 的会话")).closest("label")?.querySelector("input") as HTMLInputElement);

		// 两个来源各勾了一条，按钮计数是合计
		expect(screen.getByTestId("import-run").textContent).toContain("(2)");
		fireEvent.click(screen.getByTestId("import-run"));
		await waitFor(() => expect(posts).toHaveLength(1));
		expect(posts[0].body).toEqual({ sessions: [{ source: "claude", externalId: "c1" }, { source: "zcode", externalId: "z1" }], fallbackCwd: "/ws" });
	});

	it("已导入的行被禁用并标出来，来源统计里也计入", async () => {
		setup();
		await chooseSource("zcode");
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
		await waitFor(() => expect(screen.queryByTestId("import-run")).toBeNull());
	});

	it("全选只作用于当前来源，且跳过已导入的行", async () => {
		const { posts } = setup();
		fireEvent.click((await screen.findByText("Claude 的会话")).closest("label")?.querySelector("input") as HTMLInputElement); // 先勾一条别的来源的
		await chooseSource("zcode");
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
