// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AutomationModal } from "@/components/workspace/AutomationModal";
import type { AutomationTask } from "@/lib/automations/types";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const catalog = (provider: string) => ({ json: async () => ({ success: true, data: { models: [{ provider, id: "probe", name: provider }] } }) });
const preview = () => ({ json: async () => ({ success: true, data: { nextRunAt: Date.parse("2026-11-14T01:00:00Z"), timeZone: "Asia/Shanghai", computedAt: 0 } }) });

it("loads models from the task workspace and ignores a late catalog from its previous workspace", async () => {
	let resolveA!: (response: ReturnType<typeof catalog>) => void;
	const pendingA = new Promise<ReturnType<typeof catalog>>((resolve) => { resolveA = resolve; });
	vi.stubGlobal("fetch", vi.fn((url: string) => url.endsWith("/preview") ? Promise.resolve(preview()) : url.includes("cwd=%2Fa") ? pendingA : Promise.resolve(catalog("workspace-b"))));
	render(<AutomationModal open initialTask={null} knownCwds={["/a", "/b"]} defaultCwd="/a" getWorkspaceName={(cwd) => cwd} models={[{ provider: "other-session", id: "probe", name: "Wrong model" }]} onClose={vi.fn()} onSaved={vi.fn()} />);
	await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/models?cwd=%2Fa", expect.anything()));
	fireEvent.click(screen.getByRole("button", { name: "目标工作区" }));
	fireEvent.click(await screen.findByRole("option", { name: "/b" }));
	await waitFor(() => expect((screen.getByRole("button", { name: "指定模型" }) as HTMLButtonElement).disabled).toBe(false));
	fireEvent.click(screen.getByRole("button", { name: "指定模型" }));
	expect(await screen.findByRole("option", { name: "workspace-b / workspace-b" })).toBeTruthy();
	expect(screen.queryByRole("option", { name: /other-session/ })).toBeNull();
	await act(async () => resolveA(catalog("workspace-a")));
	expect(screen.queryByRole("option", { name: /workspace-a/ })).toBeNull();
});

it("requires a saved specific model to be available in the task workspace before saving", async () => {
	let resolveCatalog!: (response: ReturnType<typeof catalog>) => void;
	const pending = new Promise<ReturnType<typeof catalog>>((resolve) => { resolveCatalog = resolve; });
	vi.stubGlobal("fetch", vi.fn((url: string) => url.endsWith("/preview") ? Promise.resolve(preview()) : pending));
	const task: AutomationTask = { id: "task", name: "Check", prompt: "Inspect", cwd: "/b", schedule: { kind: "daily", time: "09:00" }, toolPreset: "readonly", model: { provider: "workspace-a", id: "probe" }, enabled: true, createdAt: 0, updatedAt: 0, nextRunAt: null };
	render(<AutomationModal open initialTask={task} knownCwds={["/b"]} defaultCwd="/b" getWorkspaceName={(cwd) => cwd} models={[]} onClose={vi.fn()} onSaved={vi.fn()} />);
	expect((screen.getByRole("button", { name: "确认" }) as HTMLButtonElement).disabled).toBe(true);
	await act(async () => resolveCatalog(catalog("workspace-b")));
	expect((await screen.findByRole("alert")).textContent).toContain("工作区不可用");
	expect((screen.getByRole("button", { name: "确认" }) as HTMLButtonElement).disabled).toBe(true);
	fireEvent.click(screen.getByRole("button", { name: "指定模型" }));
	fireEvent.click(await screen.findByRole("option", { name: "默认（跟随工作区或全局设置）" }));
	expect((screen.getByRole("button", { name: "确认" }) as HTMLButtonElement).disabled).toBe(false);
});
