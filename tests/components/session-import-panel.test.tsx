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

function setup(options: { sessions?: unknown[]; imported?: string[]; workspace?: string; errors?: unknown[] } = {}) {
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
				sources: ["claude", "codex", "grok", "zcode", "dsh", "opencode"],
			});
		}
		if (url === "/api/sessions/import" && init?.method === "POST") {
			posts.push({ url, body: JSON.parse(String(init.body)) });
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
	it("扫出来的会话按来源分组，默认一条都不勾选", async () => {
		setup();
		const claudeGroup = await screen.findByTestId("import-group-claude");
		expect(claudeGroup.textContent).toContain("Claude 的会话");
		expect(await screen.findByTestId("import-group-zcode")).toBeTruthy();

		const checkboxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
		expect(checkboxes).toHaveLength(3);
		expect(checkboxes.every((box) => !box.checked)).toBe(true);
		// 没勾选时导入按钮禁用
		expect((screen.getByTestId("import-run") as HTMLButtonElement).disabled).toBe(true);
	});

	it("已导入的行被禁用并标出来，分组统计里也计入", async () => {
		setup();
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

	it("全选只作用于本组，且跳过已导入的行", async () => {
		const { posts } = setup();
		await screen.findByTestId("import-group-zcode");
		// zcode 组是第 2 个分组
		const groups = screen.getAllByText("全选本组");
		fireEvent.click(groups[1]);

		expect((screen.getByTestId("import-run") as HTMLButtonElement).textContent).toContain("(1)");
		fireEvent.click(screen.getByTestId("import-run"));
		await waitFor(() => expect(posts[0].body).toEqual({ sessions: [{ source: "zcode", externalId: "z1" }], fallbackCwd: "/ws" }));
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
