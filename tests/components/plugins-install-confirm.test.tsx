// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PluginsSection } from "@/components/settings/PluginsSection";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it.each(["npm:trusted-plugin@1.0.0", "git:github.com/example/demo@v1.0.0"])("requires review of code-execution risk before installing %s", async (source) => {
	const writes: unknown[] = [];
	vi.stubGlobal("fetch", vi.fn(async (_input, init?: RequestInit) => {
		if (init?.method === "POST") writes.push(JSON.parse(String(init.body)));
		return { ok: true, json: async () => ({ success: true, data: {
			packages: [], extensions: [], featured: [{ id: "demo", name: "Demo", source, installed: writes.length > 0 }],
		} }) };
	}));
	render(<PluginsSection cwd={"C:\\workspace"} />);
	const recommended = within(await screen.findByRole("region", { name: "PiWeb 推荐扩展" }));
	fireEvent.click(recommended.getByRole("button", { name: "安装" }));
	const confirmation = await screen.findByRole("alertdialog");
	expect(confirmation.textContent).toContain(source); expect(confirmation.textContent).toContain("执行代码"); expect(writes).toEqual([]);
	fireEvent.click(within(confirmation).getByRole("button", { name: "取消" })); expect(writes).toEqual([]);
	fireEvent.click(recommended.getByRole("button", { name: "安装" }));
	fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "安装" }));
	await waitFor(() => expect(writes).toEqual([expect.objectContaining({ action: "install", source, cwd: "C:\\workspace" })]));
});
