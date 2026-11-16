import { beforeEach, expect, it, vi } from "vitest";
import { SettingsWriteBusyError } from "@/lib/settings-write-lock";

const store = vi.hoisted(() => ({
	readDefaultToolPreset: vi.fn(),
	saveDefaultToolPreset: vi.fn(),
	ToolPreferencesValidationError: class ToolPreferencesValidationError extends Error {},
}));

vi.mock("@/lib/tool-preferences", () => store);

import { GET, PUT } from "@/app/api/tool-preferences/route";

beforeEach(() => {
	vi.resetAllMocks();
});

it("reads and validates default tool preferences via /api/tool-preferences", async () => {
	store.readDefaultToolPreset.mockResolvedValue({ toolPreset: "full", saved: false });
	const getRes = await GET();
	expect(getRes.status).toBe(200);
	expect(await getRes.json()).toEqual({ success: true, data: { toolPreset: "full", saved: false } });

	const badRes = await PUT(new Request("http://localhost/api/tool-preferences", {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ toolPreset: "admin" }),
	}));
	expect(badRes.status).toBe(400);
	expect(store.saveDefaultToolPreset).not.toHaveBeenCalled();

	const okRes = await PUT(new Request("http://localhost/api/tool-preferences", {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ toolPreset: "workspace" }),
	}));
	expect(okRes.status).toBe(200);
	expect(store.saveDefaultToolPreset).toHaveBeenCalledWith("workspace");
	expect(await okRes.json()).toEqual({ success: true, data: { toolPreset: "workspace", saved: true } });
});

it("maps write lock contention to 409 with Retry-After", async () => {
	store.saveDefaultToolPreset.mockRejectedValue(new SettingsWriteBusyError(2));
	const res = await PUT(new Request("http://localhost/api/tool-preferences", {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ toolPreset: "readonly" }),
	}));
	expect(res.status).toBe(409);
	expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
});
