// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PluginMarketplace } from "@/components/settings/PluginMarketplace";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const items = (name: string) => ({ items: [{ name, source: `npm:${name}`, version: "1.0.0", description: `${name} description`, author: "", keywords: [], updatedAt: "", monthlyDownloads: null }] });

it("discards an old search body that completes after the next result has arrived", async () => {
	let resolveOld!: (body: ReturnType<typeof items>) => void;
	const oldBody = new Promise<ReturnType<typeof items>>((resolve) => { resolveOld = resolve; });
	const inspections: string[] = [];
	vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
		if (init?.method === "POST") {
			inspections.push(...JSON.parse(String(init.body)).packages.map((pkg: { name: string }) => pkg.name));
			return Promise.resolve({ ok: true, json: async () => ({ success: true, data: { compatibility: {} } }) });
		}
		return Promise.resolve({ ok: true, json: () => url.includes("q=new") ? Promise.resolve(items("new-plugin")) : oldBody });
	}));
	render(<PluginMarketplace installedPackageSources={[]} busy={false} busyKey={null} twoColumns={false} onInstall={vi.fn()} />);
	await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
	const search = screen.getByRole("searchbox");
	fireEvent.change(search, { target: { value: "new" } });
	fireEvent.keyDown(search, { key: "Enter" });
	await screen.findByText("new-plugin");
	await act(async () => resolveOld(items("old-plugin")));
	expect(screen.queryByText("old-plugin")).toBeNull();
	expect(screen.getByText("new-plugin")).toBeTruthy();
	expect(inspections).toEqual(["new-plugin"]);
});
