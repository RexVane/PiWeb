// @vitest-environment jsdom
/**
 * 设置 → 流式输出：样式 / 速度 / 打字光标三项都要能点、能存、能立刻生效。
 * 偏好是模块级单例（lib/chat/stream-settings），所以断言直接看它的返回值；
 * 用例前后都归位，免得串味到别的用例。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SettingsPanel } from "@/components/SettingsPanel";
import { DEFAULT_STREAM_SETTINGS, getStreamSettings, setStreamSettings } from "@/lib/chat/stream-settings";

vi.mock("@/lib/theme", () => ({ applyPebrelTheme: () => {}, loadPebrelTheme: () => "dsh", loadThemeMode: () => "system" }));

beforeEach(() => setStreamSettings(DEFAULT_STREAM_SETTINGS));

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	setStreamSettings(DEFAULT_STREAM_SETTINGS);
});

function response(data: unknown) {
	return { ok: true, status: 200, json: async () => ({ success: true, data }) };
}

function setup() {
	vi.stubGlobal("fetch", vi.fn(async (url: string) => {
		if (url === "/api/security") return response({ defaultProjectTrust: "ask" });
		if (url === "/api/pi-settings") return response({ compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 20 }, retry: { enabled: true, maxRetries: 3, baseDelayMs: 50 } });
		if (url === "/api/version") return response({ piWeb: "0.test", piEngine: "0.test" });
		if (url === "/api/web-auth") return response({ enabled: false });
		throw new Error(`unexpected URL ${url}`);
	}));
	render(<SettingsPanel open cwd="/test-workspace" toolPreset="standard" onClose={vi.fn()} onToolPresetChange={vi.fn()} />);
}

describe("设置里的流式输出", () => {
	it("选样式 / 速度 / 光标都即时落到偏好里", async () => {
		setup();

		const typewriter = await screen.findByRole("button", { name: /打字机/ });
		fireEvent.click(typewriter);
		expect(getStreamSettings().style).toBe("typewriter");
		expect(typewriter.getAttribute("aria-pressed")).toBe("true");

		fireEvent.click(screen.getByRole("button", { name: "极快" }));
		expect(getStreamSettings().speed).toBe(5);

		const caret = screen.getByRole("switch", { name: "打字光标" });
		expect(caret.getAttribute("aria-checked")).toBe("false");
		fireEvent.click(caret);
		expect(getStreamSettings().caret).toBe(true);
		expect(caret.getAttribute("aria-checked")).toBe("true");
	});

	it("已存的偏好会在打开设置时读回来（不要显示成默认值）", async () => {
		setStreamSettings({ style: "fade", speed: 1, caret: true });
		setup();
		expect((await screen.findByRole("button", { name: /渐显/ })).getAttribute("aria-pressed")).toBe("true");
		expect(screen.getByRole("button", { name: "慢" }).getAttribute("aria-pressed")).toBe("true");
		expect(screen.getByRole("switch", { name: "打字光标" }).getAttribute("aria-checked")).toBe("true");
	});

	it("即时样式下速度置灰，换回别的样式又能调", async () => {
		setStreamSettings({ style: "instant" });
		setup();
		const fastest = (await screen.findByRole("button", { name: "极快" })) as HTMLButtonElement;
		expect(fastest.disabled).toBe(true);
		fireEvent.click(screen.getByRole("button", { name: /^平滑/ }));
		expect(fastest.disabled).toBe(false);
	});
});
