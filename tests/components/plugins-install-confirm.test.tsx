// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { PluginsSection } from "@/components/settings/PluginsSection";
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("ignores legacy recommendations without exposing an install action", async () => {
 vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ success: true, data: { packages: [], extensions: [], featured: [{ id: "legacy", name: "Legacy recommendation", source: "npm:legacy" }] } }) })));
 render(<PluginsSection cwd="/workspace" />);
 await waitFor(() => expect(screen.queryByLabelText("正在加载插件…")).toBeNull());
 expect(screen.queryByText("Legacy recommendation")).toBeNull();
 expect(screen.queryByRole("button", { name: "安装" })).toBeNull();
});
