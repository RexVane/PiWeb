// @vitest-environment jsdom
/**
 * 插件/扩展卡片的状态显示与统一布局回归测试。
 *
 * 覆盖：
 * 1. 停用的本地扩展：头部只有「已停用」，展开后不会冒出矛盾的「已启用」。
 * 2. 停用的包不能点「更新」，并提示先启用；启用的包照常可点。
 * 3. 内置扩展展示描述并支持 switch 直接切换；支持在「已安装」与「插件市场」之间切换与安装。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { PluginsSection } from "@/components/settings/PluginsSection";


afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

const EXTENSIONS = [
	{ name: "orca-titlebar-spinner", path: "/home/user/.pi/agent/extensions/orca-titlebar-spinner.ts", disabled: true, sourceInfo: { source: "auto", scope: "user", origin: "top-level" } },
	{ name: "orca-agent-status", path: "/home/user/.pi/agent/extensions/orca-agent-status.ts", disabled: false, sourceInfo: { source: "auto", scope: "user", origin: "top-level" } },
];

function stubPlugins() {
	vi.stubGlobal("fetch", vi.fn(async () => ({
		ok: true,
		json: async () => ({ success: true, data: { packages: [], extensions: EXTENSIONS } }),
	})));
}

const rowOf = (name: string) => {
	let node: HTMLElement | null = screen.getByText(name);
	while (node && !node.querySelector('[role="switch"]')) node = node.parentElement;
	if (!node) throw new Error(`找不到 ${name} 所在行`);
	return node;
};

describe("插件页面状态与布局", () => {
	it("按 SDK 来源显示整包开关和作用域，不额外加载资源界面设置", async () => {
		const fetchMock = vi.fn(async (_input: RequestInfo | URL) => ({
			ok: true,
			json: async () => ({ success: true, data: {
				packages: [{ source: "/workspace/local-package", scope: "project", resources: { extensions: 1, skills: 0, prompts: 0, themes: 0 } }],
				extensions: [
					{ name: "package-child", path: "/workspace/local-package/child.js", scope: "project", origin: "package", sourceInfo: { origin: "package", source: "/workspace/local-package", scope: "project" } },
					{ name: "workspace-file-global-config", path: "/workspace/global.js", scope: "user", origin: "top-level", sourceInfo: { origin: "top-level", source: "local", scope: "user" } },
					{ name: "external-file-project-config", path: "/outside/project.js", scope: "project", origin: "top-level", sourceInfo: { origin: "top-level", source: "local", scope: "project" } },
				],
			} }),
		}));
		vi.stubGlobal("fetch", fetchMock);
		render(<PluginsSection cwd="/workspace" />);
		await screen.findByText("workspace-file-global-config");
		expect(screen.getByRole("heading", { name: "已安装的 pi 包" })).toBeTruthy();
		expect(fetchMock.mock.calls.some(([input]) => String(input).startsWith("/api/resources"))).toBe(false);
		expect(screen.queryByRole("switch", { name: "package-child" })).toBeNull();
		expect(screen.queryByText("package-child")).toBeNull();
		expect(screen.getByRole("switch", { name: "local-package" })).toBeTruthy();
		expect(screen.queryByText("/workspace/local-package")).toBeNull();
		fireEvent.click(screen.getByText("local-package"));
		expect(screen.getByText("/workspace/local-package")).toBeTruthy();
		fireEvent.click(screen.getByText("local-package"));
		expect(within(rowOf("workspace-file-global-config")).getByText("个人")).toBeTruthy();
		expect(within(rowOf("external-file-project-config")).getByText("项目")).toBeTruthy();
		fireEvent.click(screen.getByRole("tab", { name: /个人/ }));
		expect(screen.getByText("workspace-file-global-config")).toBeTruthy();
		expect(screen.queryByText("external-file-project-config")).toBeNull();
		expect(screen.queryByRole("switch", { name: "local-package" })).toBeNull();
		fireEvent.click(screen.getByRole("tab", { name: /项目/ }));
		expect(screen.queryByText("workspace-file-global-config")).toBeNull();
		expect(screen.getByText("external-file-project-config")).toBeTruthy();
		expect(screen.getByRole("switch", { name: "local-package" })).toBeTruthy();
	});

	it("停用的扩展：行内只有「已停用」，展开后不会又冒出「已启用」", async () => {
		stubPlugins();
		render(<PluginsSection cwd="/workspace" />);
		const row = await screen.findByText("orca-titlebar-spinner").then(() => rowOf("orca-titlebar-spinner"));
		expect(within(row).getByText("已停用")).toBeTruthy();

		fireEvent.click(within(row).getByText("orca-titlebar-spinner"));
		expect(within(row).queryByText("已启用")).toBeNull();
		expect(within(row).getAllByText(/已停用|已启用/)).toHaveLength(1);
	});

	it("停用的包不能点「更新」，并提示先启用；启用的包照常可点", async () => {
		const resources = { extensions: 1, skills: 0, prompts: 0, themes: 0 };
		vi.stubGlobal("fetch", vi.fn(async () => ({
			ok: true,
			json: async () => ({
				success: true,
				data: {
					packages: [
						{ source: "npm:pi-off", scope: "user", resources, disabled: true },
						{ source: "npm:pi-on", scope: "user", resources, disabled: false },
					],
					extensions: [],
				},
			}),
		})));
		render(<PluginsSection cwd="/workspace" />);
		await screen.findByText("pi-off");

		const offRow = rowOf("pi-off");
		const offUpdate = within(offRow).getByRole("button", { name: "更新" }) as HTMLButtonElement;
		expect(offUpdate.disabled).toBe(true);
		expect(offUpdate.title).toMatch(/先启用.*更新/);

		const onRow = rowOf("pi-on");
		const onUpdate = within(onRow).getByRole("button", { name: "更新" }) as HTMLButtonElement;
		expect(onUpdate.disabled).toBe(false);
	});

	it("启用的扩展显示「已启用」，保留内置扩展分节", async () => {
		const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url.startsWith("/api/plugins/marketplace")) {
				return {
					ok: true,
					json: async () => ({
						total: 1,
						items: [
							{
								name: "pi-mcp-adapter",
								source: "npm:pi-mcp-adapter",
								version: "7.0.1",
								description: "MCP adapter extension for Pi",
								author: "nicopreme",
								keywords: ["mcp", "extension"],
								updatedAt: "2026-11-04T05:43:33.957Z",
								monthlyDownloads: 1700,
								npmUrl: "https://www.npmjs.com/package/pi-mcp-adapter",
							},
						],
					}),
				};
			}
			if (url === "/api/plugins" && init?.method === "POST") {
				return {
					ok: true,
					json: async () => ({ success: true, data: {} }),
				};
			}
			return {
				ok: true,
				json: async () => ({
					success: true,
					data: {
						packages: [],
						extensions: [
							{ name: "codemode", path: "builtin:codemode", disabled: false },
							...EXTENSIONS,
						],
					},
				}),
			};
		});
		vi.stubGlobal("fetch", fetchMock);
		render(<PluginsSection cwd="/workspace" />);
		await screen.findByText("orca-agent-status");
		const enabled = rowOf("orca-agent-status");
		const disabled = rowOf("orca-titlebar-spinner");
		expect(within(enabled).getByText("已启用")).toBeTruthy();
		expect(within(disabled).getByText("已停用")).toBeTruthy();
		expect(within(enabled).queryByText("已停用")).toBeNull();
		expect(screen.getByRole("heading", { name: /^内置(?:插件|扩展)(?:配置)?$/ })).toBeTruthy();
		expect(screen.getByRole("switch", { name: "Codemode" })).toBeTruthy();
		expect(screen.queryByText(/尚未安装任何 pi 包/)).toBeNull();
		// 市场已经独立成「资源市场」页，这边不再有市场页签
		expect(screen.queryByRole("tab", { name: /市场/ })).toBeNull();
	});


});
