// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { SkillsSection } from "@/components/settings/SkillsSection";
import { PluginsSection } from "@/components/settings/PluginsSection";
import { PluginsWorkspaceView, SkillsWorkspaceView } from "@/components/workspace/SkillsPluginsViews";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
const response = (data: unknown) => ({ json: async () => ({ success: true, data }) });
const skill = (name: string, cwd: string) => ({ name, description: `Description of ${name}`, filePath: `${cwd}/SKILL.md`, scope: "project", disabled: false });
const extension = (name: string) => ({ name, path: `/external/${name}.js`, sourceInfo: { source: "local", origin: "top-level", scope: "project" } });

describe("workspace resource requests", () => {
	it.each(["skills", "plugins"] as const)("sends %s controls to the selected workspace", async (kind) => {
		const posts: Record<string, unknown>[] = [];
		vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
			if (init?.method === "POST") { posts.push(JSON.parse(String(init.body))); return Promise.resolve(response({})); }
			const cwd = new URL(url, "http://localhost").searchParams.get("cwd") || "";
			return Promise.resolve(response(kind === "skills" ? { skills: [skill("Resource", cwd)] } : { packages: [], extensions: [extension("Resource")] }));
		}));
		const props = { knownCwds: ["/a", "/b"], defaultCwd: "/a", getWorkspaceName: (cwd: string) => cwd };
		render(kind === "skills" ? <SkillsWorkspaceView {...props} /> : <PluginsWorkspaceView {...props} />);
		await screen.findByText("Resource"); fireEvent.click(screen.getByRole("tab", { name: /项目/ }));
		fireEvent.click(screen.getByRole("button", { name: "当前工作区" })); fireEvent.click(await screen.findByRole("option", { name: "/b" }));
		await screen.findByText("Resource"); fireEvent.click(screen.getByRole("switch", { name: "Resource" }));
		await waitFor(() => expect(posts).toHaveLength(1)); expect(posts[0]).toMatchObject({ action: "toggle", cwd: "/b" });
		if (kind === "skills") expect(posts[0].filePath).toBe("/b/SKILL.md");
	});
	it.each(["skills", "plugins"] as const)("ignores an older %s response after switching workspaces", async (kind) => {
		const old = deferred<ReturnType<typeof response>>();
		vi.stubGlobal("fetch", vi.fn((url: string) => url.includes("cwd=%2Fa") ? old.promise : Promise.resolve(response(kind === "skills" ? { skills: [skill("B resource", "/b")] } : { packages: [], extensions: [extension("B resource")] }))));
		const { rerender } = render(kind === "skills" ? <SkillsSection cwd="/a" /> : <PluginsSection cwd="/a" />);
		rerender(kind === "skills" ? <SkillsSection cwd="/b" /> : <PluginsSection cwd="/b" />); await screen.findByText("B resource");
		await act(async () => { old.resolve(response(kind === "skills" ? { skills: [skill("A resource", "/a")] } : { packages: [], extensions: [extension("A resource")] })); });
		expect(screen.queryByText("A resource")).toBeNull(); expect(screen.getByText("B resource")).toBeTruthy();
	});
	it.each(["skills", "plugins"] as const)("clears old %s while the new workspace is still loading", async (kind) => {
		const next = deferred<ReturnType<typeof response>>();
		vi.stubGlobal("fetch", vi.fn((url: string) => url.includes("cwd=%2Fb") ? next.promise : Promise.resolve(response(kind === "skills" ? { skills: [skill("A resource", "/a")] } : { packages: [], extensions: [extension("A resource")] }))));
		const { rerender } = render(kind === "skills" ? <SkillsSection cwd="/a" /> : <PluginsSection cwd="/a" />); await screen.findByText("A resource");
		rerender(kind === "skills" ? <SkillsSection cwd="/b" /> : <PluginsSection cwd="/b" />); expect(screen.queryByText("A resource")).toBeNull();
		await act(async () => { next.resolve(response({ skills: [] })); });
	});
	it("cancels a plugin uninstall confirmation when its workspace changes", async () => {
		const posts = vi.fn();
		vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => {
			if (init?.method === "POST") { posts(); return Promise.resolve(response({})); }
			return Promise.resolve(response({ packages: [{ source: "npm:demo", scope: "project", resources: { extensions: 1, skills: 0, prompts: 0, themes: 0 } }], extensions: [] }));
		}));
		const { rerender } = render(<PluginsSection cwd="/a" />); fireEvent.click(await screen.findByRole("button", { name: "卸载" }));
		const dialog = await screen.findByRole("alertdialog"); rerender(<PluginsSection cwd="/b" />); fireEvent.click(within(dialog).getByRole("button", { name: "卸载" }));
		await act(async () => {}); expect(posts).not.toHaveBeenCalled();
	});
	it("keeps an installation dialog open while saving", async () => {
		const saving = deferred<ReturnType<typeof response>>();
		vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => init?.method === "POST" ? saving.promise : Promise.resolve(response({ packages: [], extensions: [] }))));
		render(<PluginsSection cwd="/ws" />); fireEvent.click(screen.getByRole("button", { name: /添加(?:插件|扩展)/ }));
		fireEvent.click(screen.getByRole("menuitem", { name: /安装已有扩展/ }));
		const dialog = await screen.findByRole("dialog"); fireEvent.change(within(dialog).getByRole("textbox", { name: /npm/ }), { target: { value: "npm:demo" } });
		fireEvent.click(within(dialog).getByRole("button", { name: "安装" })); fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "安装" }));
		await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === "POST")).toBe(true));
		fireEvent.keyDown(document, { key: "Escape" }); expect(screen.getByRole("dialog")).toBeTruthy();
		await act(async () => { saving.resolve(response({})); }); await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	});
	it("does not open a skill read response from a previous workspace", async () => {
		const read = deferred<ReturnType<typeof response>>(); const onOpen = vi.fn();
		vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => init?.method === "POST" ? read.promise : Promise.resolve(response({ skills: [skill("Resource", "/a")] }))));
		const { rerender } = render(<SkillsSection cwd="/a" onOpenFileContent={onOpen} />); fireEvent.click(await screen.findByRole("button", { name: "查看 SKILL.md" }));
		rerender(<SkillsSection cwd="/b" onOpenFileContent={onOpen} />); await act(async () => { read.resolve(response({ content: "old document" })); }); expect(onOpen).not.toHaveBeenCalled();
	});
	it("shows a skill operation network error", async () => {
		vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => init?.method === "POST" ? Promise.reject(new Error("skill network failed")) : Promise.resolve(response({ skills: [skill("Resource", "/a")] }))));
		render(<SkillsSection cwd="/a" />); fireEvent.click(await screen.findByRole("switch", { name: "Resource" })); expect((await screen.findByRole("alert")).textContent).toContain("skill network failed");
	});
});
