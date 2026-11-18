// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { SkillsSection } from "@/components/settings/SkillsSection";
import { PluginsSection } from "@/components/settings/PluginsSection";
import { AutomationModal } from "@/components/workspace/AutomationModal";
import { AutomationsWorkspaceView } from "@/components/workspace/AutomationsWorkspaceView";
import { PluginsWorkspaceView, SkillsWorkspaceView } from "@/components/workspace/SkillsPluginsViews";
import type { AutomationTask } from "@/lib/automations/types";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}
const response = (data: unknown) => ({ json: async () => ({ success: true, data }) });
const skill = (name: string, cwd: string) => ({ name, description: `Description of ${name}`, filePath: `${cwd}/SKILL.md`, scope: "project", disabled: false });
const extension = (name: string) => ({ name, path: `/external/${name}.js`, sourceInfo: { source: "local", origin: "top-level", scope: "project" } });

describe("workspace resource requests", () => {
	it.each(["skills", "plugins"] as const)("sends %s controls to the selected workspace", async (kind) => {
		const posts: Record<string, unknown>[] = [];
		vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
			if (init?.method === "POST") {
				posts.push(JSON.parse(String(init.body)));
				return Promise.resolve(response({}));
			}
			const cwd = new URL(url, "http://localhost").searchParams.get("cwd") || "";
			return Promise.resolve(response(kind === "skills" ? { skills: [skill("Resource", cwd)] } : { packages: [], extensions: [extension("Resource")] }));
		}));
		const props = { knownCwds: ["/a", "/b"], defaultCwd: "/a", getWorkspaceName: (cwd: string) => cwd };
		render(kind === "skills" ? <SkillsWorkspaceView {...props} /> : <PluginsWorkspaceView {...props} />);
		await screen.findByText("Resource");
		// 技能/扩展页的工作区选择器都在「项目」页签下才出现（个人级不需要选工作区）
		fireEvent.click(screen.getByRole("tab", { name: /项目/ }));
		fireEvent.click(screen.getByRole("button", { name: "当前工作区" }));
		fireEvent.click(await screen.findByRole("option", { name: "/b" }));
		await screen.findByText("Resource");
		fireEvent.click(screen.getByRole("switch", { name: "Resource" }));
		await waitFor(() => expect(posts).toHaveLength(1));
		expect(posts[0]).toMatchObject({ action: "toggle", cwd: "/b" });
		if (kind === "skills") expect(posts[0].filePath).toBe("/b/SKILL.md");
	});
	it.each(["skills", "plugins"] as const)("ignores an older %s response after switching workspaces", async (kind) => {
		const old = deferred<ReturnType<typeof response>>();
		vi.stubGlobal("fetch", vi.fn((url: string) => url.includes("cwd=%2Fa") ? old.promise : Promise.resolve(response(kind === "skills" ? { skills: [skill("B resource", "/b")] } : { packages: [], extensions: [extension("B resource")] }))));
		const { rerender } = render(kind === "skills" ? <SkillsSection cwd="/a" /> : <PluginsSection cwd="/a" />);
		rerender(kind === "skills" ? <SkillsSection cwd="/b" /> : <PluginsSection cwd="/b" />);
		await screen.findByText("B resource");
		await act(async () => { old.resolve(response(kind === "skills" ? { skills: [skill("A resource", "/a")] } : { packages: [], extensions: [extension("A resource")] })); });
		expect(screen.queryByText("A resource")).toBeNull();
		expect(screen.getByText("B resource")).toBeTruthy();
	});

	it.each(["skills", "plugins"] as const)("clears old %s while the new workspace is still loading", async (kind) => {
		const next = deferred<ReturnType<typeof response>>();
		vi.stubGlobal("fetch", vi.fn((url: string) => url.includes("cwd=%2Fb") ? next.promise : Promise.resolve(response(kind === "skills" ? { skills: [skill("A resource", "/a")] } : { packages: [], extensions: [extension("A resource")] }))));
		const { rerender } = render(kind === "skills" ? <SkillsSection cwd="/a" /> : <PluginsSection cwd="/a" />);
		await screen.findByText("A resource");
		rerender(kind === "skills" ? <SkillsSection cwd="/b" /> : <PluginsSection cwd="/b" />);
		expect(screen.queryByText("A resource")).toBeNull();
		await act(async () => { next.resolve(response({ skills: [] })); });
	});

	it("cancels a plugin uninstall confirmation when its workspace changes", async () => {
		const posts = vi.fn();
		vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => {
			if (init?.method === "POST") { posts(); return Promise.resolve(response({})); }
			return Promise.resolve(response({ packages: [{ source: "npm:demo", scope: "project", resources: { extensions: 1, skills: 0, prompts: 0, themes: 0 } }], extensions: [] }));
		}));
		const { rerender } = render(<PluginsSection cwd="/a" />);
		fireEvent.click(await screen.findByRole("button", { name: "卸载" }));
		const dialog = await screen.findByRole("alertdialog");
		rerender(<PluginsSection cwd="/b" />);
		fireEvent.click(within(dialog).getByRole("button", { name: "卸载" }));
		await act(async () => {});
		expect(posts).not.toHaveBeenCalled();
	});

	it("keeps an installation dialog open while saving", async () => {
		const saving = deferred<ReturnType<typeof response>>();
		vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => init?.method === "POST" ? saving.promise : Promise.resolve(response({ packages: [], extensions: [] }))));
		render(<PluginsSection cwd="/ws" />);
		fireEvent.click(screen.getByRole("button", { name: /添加(?:插件|扩展)/ }));
		const dialog = await screen.findByRole("dialog");
		fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "npm:demo" } });
		fireEvent.click(within(dialog).getByRole("button", { name: "安装" }));
		fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "安装" }));
		await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === "POST")).toBe(true));
		fireEvent.keyDown(document, { key: "Escape" });
		expect(screen.getByRole("dialog")).toBeTruthy();
		await act(async () => { saving.resolve(response({})); });
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	});

	it("does not open a skill read response from a previous workspace", async () => {
		const read = deferred<ReturnType<typeof response>>();
		const onOpen = vi.fn();
		vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => init?.method === "POST" ? read.promise : Promise.resolve(response({ skills: [skill("Resource", "/a")] }))));
		const { rerender } = render(<SkillsSection cwd="/a" onOpenFileContent={onOpen} />);
		fireEvent.click(await screen.findByRole("button", { name: "查看 SKILL.md" }));
		rerender(<SkillsSection cwd="/b" onOpenFileContent={onOpen} />);
		await act(async () => { read.resolve(response({ content: "old document" })); });
		expect(onOpen).not.toHaveBeenCalled();
	});

	it("shows a skill operation network error", async () => {
		vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => init?.method === "POST" ? Promise.reject(new Error("skill network failed")) : Promise.resolve(response({ skills: [skill("Resource", "/a")] }))));
		render(<SkillsSection cwd="/a" />);
		fireEvent.click(await screen.findByRole("switch", { name: "Resource" }));
		expect((await screen.findByRole("alert")).textContent).toContain("skill network failed");
	});
});

const task: AutomationTask = { id: "task-1", name: "Task", prompt: "Inspect repo", cwd: "/ws", schedule: { kind: "daily", time: "09:00" }, enabled: true, createdAt: 1, updatedAt: 1, nextRunAt: Date.now() + 60_000 };

describe("automation form and requests", () => {
	it("preserves unsaved form edits when the workspace list is repolled", () => {
		const props = { open: true, initialTask: null, defaultCwd: "/ws", getWorkspaceName: (cwd: string) => cwd, models: [], onClose: vi.fn(), onSaved: vi.fn() };
		const { rerender } = render(<AutomationModal {...props} knownCwds={["/ws"]} />);
		const name = screen.getByPlaceholderText(/每日代码/) as HTMLInputElement;
		fireEvent.change(name, { target: { value: "My unsaved task" } });
		fireEvent.change(screen.getByPlaceholderText(/描述每次触发/), { target: { value: "Keep these instructions" } });
		rerender(<AutomationModal {...props} knownCwds={["/ws", "/new"]} />);
		expect(name.value).toBe("My unsaved task");
		expect((screen.getByPlaceholderText(/描述每次触发/) as HTMLTextAreaElement).value).toBe("Keep these instructions");
	});

	it("preserves edits when the same task is refreshed and resets on reopening", () => {
		const props = { open: true, initialTask: task, defaultCwd: "/ws", knownCwds: ["/ws"], getWorkspaceName: (cwd: string) => cwd, models: [], onClose: vi.fn(), onSaved: vi.fn() };
		const { rerender } = render(<AutomationModal {...props} />);
		fireEvent.change(screen.getByPlaceholderText(/每日代码/), { target: { value: "Edited task" } });
		rerender(<AutomationModal {...props} initialTask={{ ...task, updatedAt: 2 }} />);
		expect((screen.getByPlaceholderText(/每日代码/) as HTMLInputElement).value).toBe("Edited task");
		rerender(<AutomationModal {...props} open={false} />);
		rerender(<AutomationModal {...props} />);
		expect((screen.getByPlaceholderText(/每日代码/) as HTMLInputElement).value).toBe(task.name);
	});

	it("does not close a task dialog with Escape while saving", async () => {
		const saving = deferred<ReturnType<typeof response>>();
		const onClose = vi.fn();
		const onSaved = vi.fn();
		vi.stubGlobal("fetch", vi.fn(() => saving.promise));
		render(<AutomationModal open initialTask={task} knownCwds={["/ws"]} defaultCwd="/ws" getWorkspaceName={(cwd) => cwd} models={[]} onClose={onClose} onSaved={onSaved} />);
		fireEvent.click(screen.getByRole("button", { name: "确认" }));
		fireEvent.keyDown(document, { key: "Escape" });
		expect(onClose).not.toHaveBeenCalled();
		await act(async () => { saving.resolve(response({})); });
		expect(onSaved).toHaveBeenCalledOnce();
		expect(onClose).toHaveBeenCalledOnce();
	});

	it("keeps another task busy when an overlapping action completes", async () => {
		const first = deferred<ReturnType<typeof response>>();
		const second = deferred<ReturnType<typeof response>>();
		vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => {
			if (init?.method === "POST") return JSON.parse(String(init.body)).id === task.id ? first.promise : second.promise;
			return Promise.resolve(response({ tasks: [task, { ...task, id: "task-2", name: "Task 2" }], runs: [], activeTaskIds: [] }));
		}));
		render(<AutomationsWorkspaceView knownCwds={["/ws"]} defaultCwd="/ws" getWorkspaceName={(cwd) => cwd} models={[]} onOpenSession={vi.fn()} />);
		await screen.findByText("Task 2");
		const buttons = screen.getAllByRole("button", { name: "立即运行" }) as HTMLButtonElement[];
		fireEvent.click(buttons[0]);
		fireEvent.click(buttons[1]);
		await act(async () => { first.resolve(response({})); });
		expect(buttons[1].disabled).toBe(true);
		await act(async () => { second.resolve(response({})); });
		expect(buttons[1].disabled).toBe(false);
	});

	it("refreshes a successful concurrent action even when the last action fails", async () => {
		const first = deferred<ReturnType<typeof response>>();
		const second = deferred<{ json: () => Promise<unknown> }>();
		const state = { tasks: [task, { ...task, id: "task-2", name: "Task 2" }], runs: [], activeTaskIds: [] };
		vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => {
			if (init?.method === "POST") return JSON.parse(String(init.body)).id === task.id ? first.promise : second.promise;
			return Promise.resolve(response(state));
		}));
		render(<AutomationsWorkspaceView knownCwds={["/ws"]} defaultCwd="/ws" getWorkspaceName={(cwd) => cwd} models={[]} onOpenSession={vi.fn()} />);
		await screen.findByText("Task 2");
		const buttons = screen.getAllByRole("button", { name: "立即运行" });
		fireEvent.click(buttons[0]);
		fireEvent.click(buttons[1]);
		state.tasks = [{ ...task, name: "Updated task" }, state.tasks[1]];
		await act(async () => { first.resolve(response({})); });
		await act(async () => { second.resolve({ json: async () => ({ success: false, error: "Second task failed" }) }); });
		expect(await screen.findByText("Updated task")).toBeTruthy();
		expect(screen.getByRole("alert").textContent).toContain("Second task failed");
	});

	it("shows an immediate-run network error and allows retry", async () => {
		const fetchMock = vi.fn((_url: string, init?: RequestInit) => init?.method === "POST" ? Promise.reject(new Error("automation network failed")) : Promise.resolve(response({ tasks: [task], runs: [], activeTaskIds: [] })));
		vi.stubGlobal("fetch", fetchMock);
		render(<AutomationsWorkspaceView knownCwds={["/ws"]} defaultCwd="/ws" getWorkspaceName={(cwd) => cwd} models={[]} onOpenSession={vi.fn()} />);
		fireEvent.click(await screen.findByRole("button", { name: "立即运行" }));
		expect((await screen.findByRole("alert")).textContent).toContain("automation network failed");
		expect((screen.getByRole("button", { name: "立即运行" }) as HTMLButtonElement).disabled).toBe(false);
	});

	it("does not restore deleted tasks from an older list request", async () => {
		const oldRefresh = deferred<ReturnType<typeof response>>();
		let reads = 0;
		vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => {
			if (init?.method === "POST") return Promise.resolve(response({}));
			reads += 1;
			if (reads === 1) return Promise.resolve(response({ tasks: [task], runs: [], activeTaskIds: [] }));
			if (reads === 2) return oldRefresh.promise;
			return Promise.resolve(response({ tasks: [], runs: [], activeTaskIds: [] }));
		}));
		render(<AutomationsWorkspaceView knownCwds={["/ws"]} defaultCwd="/ws" getWorkspaceName={(cwd) => cwd} models={[]} onOpenSession={vi.fn()} />);
		await screen.findByText("Task");
		fireEvent.click(screen.getByRole("button", { name: "刷新" }));
		fireEvent.click(screen.getByRole("button", { name: "删除" }));
		fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "删除" }));
		await waitFor(() => expect(screen.queryByText("Task")).toBeNull());
		await act(async () => { oldRefresh.resolve(response({ tasks: [task], runs: [], activeTaskIds: [] })); });
		expect(screen.queryByText("Task")).toBeNull();
	});
});
