// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { SettingsPanel } from "@/components/SettingsPanel";

vi.mock("@/lib/ui/theme", () => ({ applyPebrelTheme: () => {}, loadPebrelTheme: () => "dsh", loadThemeMode: () => "system" }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const skills = [
	{ name: "mine", description: "in pi's skills folder", filePath: "/a/skills/mine/SKILL.md", disabled: false, scope: "global", deletable: true, baseDir: "/a/skills/mine" },
	{ name: "listed", description: "a path set in settings", filePath: "/code/listed/SKILL.md", disabled: false, scope: "global", deletable: false, baseDir: "/code/listed" },
	{ name: "packaged", description: "from a package", filePath: "/a/npm/node_modules/p/skills/x/SKILL.md", disabled: false, scope: "package", deletable: false, baseDir: "/a/npm/node_modules/p/skills/x" },
];

describe("settings → skills", () => {
	it("offers delete only where the server can delete, and says what to do for the rest", async () => {
		const posts: unknown[] = [];
		const ok = (data: unknown) => ({ ok: true, status: 200, json: async () => ({ success: true, data }) });
		vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
			if (url.startsWith("/api/skills")) {
				if (init?.method === "POST") posts.push(JSON.parse(String(init.body)));
				return ok(init?.method === "POST" ? { removed: "/a/skills/mine" } : { skills });
			}
			if (url === "/api/pi-settings") return ok({ compaction: { enabled: true, reserveTokens: 1, keepRecentTokens: 1 }, retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 }, thinking: { defaultLevel: null, modelLevels: {}, budgets: {} }, defaultModel: null });
			if (url === "/api/security") return ok({ defaultProjectTrust: "ask" });
			if (url === "/api/version") return ok({ piWeb: "0.test", piEngine: "0.test" });
			if (url === "/api/web-auth") return ok({ enabled: false });
			throw new Error(`unexpected URL ${url}`);
		}));
		const confirm = vi.fn(() => true);
		vi.stubGlobal("confirm", confirm);
		render(<SettingsPanel open cwd="/w" toolPreset="standard" onClose={vi.fn()} onToolPresetChange={vi.fn()} />);
		fireEvent.click(screen.getByRole("button", { name: "技能" }));
		const row = async (name: string) => (await screen.findByText(name)).closest("div.rounded-2xl") as HTMLElement;

		expect(within(await row("listed")).queryByRole("button", { name: "删除" })).toBeNull();
		expect(within(await row("listed")).getByText("不在 pi 的技能目录里，请手动删除")).toBeTruthy();
		expect(within(await row("packaged")).queryByRole("button", { name: "删除" })).toBeNull();
		expect(within(await row("packaged")).getByText("包技能请用禁用管理")).toBeTruthy();

		fireEvent.click(within(await row("mine")).getByRole("button", { name: "删除" }));
		expect(confirm).toHaveBeenCalledWith(expect.stringContaining("单文件技能只删这个文件"));
		await waitFor(() => expect(posts).toEqual([{ action: "delete", filePath: "/a/skills/mine/SKILL.md", cwd: "/w" }]));
	});
});
