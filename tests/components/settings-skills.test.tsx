// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SettingsPanel } from "@/components/SettingsPanel";

vi.mock("@/lib/theme", () => ({ applyPebrelTheme: () => {}, loadPebrelTheme: () => "piweb", loadThemeMode: () => "system" }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const skill = { name: "qa-skill", description: "Test skill", scope: "global", filePath: "/agent/skills/qa-skill/SKILL.md", disabled: false };
const success = (data: unknown) => ({ ok: true, status: 200, json: async () => ({ success: true, data }) });
const general = (url: string) => {
	if (url === "/api/pi-settings") return success({ compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 20 }, retry: { enabled: true, maxRetries: 3, baseDelayMs: 50 } });
	if (url === "/api/security") return success({ defaultProjectTrust: "ask" });
	if (url === "/api/version") return success({ piWeb: "0.test", piEngine: "0.test" });
	if (url === "/api/web-auth") return success({ enabled: false, authenticated: false });
	throw new Error(`unexpected URL ${url}`);
};

function mount(fetchMock: ReturnType<typeof vi.fn>) {
	vi.stubGlobal("fetch", fetchMock);
	render(<SettingsPanel open cwd="/workspace" toolPreset="standard" onClose={vi.fn()} onToolPresetChange={vi.fn()} />);
	fireEvent.click(screen.getByRole("button", { name: /技能|Skills/ }));
}

it("shows a retry action after the skills list fails to load", async () => {
	let attempts = 0;
	const fetchMock = vi.fn(async (url: string) => {
		if (url.startsWith("/api/skills")) {
			attempts += 1;
			if (attempts === 1) throw new Error("skills unavailable");
			return success({ skills: [skill] });
		}
		return general(url);
	});
	mount(fetchMock);
	await screen.findByRole("alert");
	expect(screen.getByRole("alert").textContent).toContain("skills unavailable");
	fireEvent.click(screen.getByRole("button", { name: /重试|Retry/ }));
	await screen.findByText("qa-skill");
	expect(screen.queryByRole("alert")).toBeNull();
});

it("distinguishes loading from an empty skills list", async () => {
	let resolveSkills!: (value: ReturnType<typeof success>) => void;
	const pendingSkills = new Promise<ReturnType<typeof success>>((resolve) => { resolveSkills = resolve; });
	const fetchMock = vi.fn(async (url: string) => {
		if (url.startsWith("/api/skills")) return pendingSkills;
		return general(url);
	});
	mount(fetchMock);
	expect(screen.getByRole("status").textContent).toMatch(/正在加载技能|Loading skills/);
	resolveSkills(success({ skills: [] }));
	await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/没有可用技能|No skills available/));
});

it("keeps a skill enabled and reports a failed toggle request", async () => {
	const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
		if (url.startsWith("/api/skills") && init?.method === "POST") throw new Error("toggle unavailable");
		if (url.startsWith("/api/skills")) return success({ skills: [skill] });
		return general(url);
	});
	mount(fetchMock);
	const toggle = await screen.findByRole("switch", { name: "qa-skill" });
	fireEvent.click(toggle);
	await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("toggle unavailable"));
	expect(toggle.getAttribute("aria-checked")).toBe("true");
	expect((toggle as HTMLButtonElement).disabled).toBe(false);
});
