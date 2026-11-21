// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ResourceControls } from "@/components/resources/ResourceControls";
import type { WebResourceView } from "@/lib/resources/protocol";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const view: WebResourceView = { id: "project:demo:main", resourceId: "demo", scope: "project", title: "Demo interface", placement: "aboveEditor", methods: ["select"], url: "/api/resources/views/abcd/assets/index.html" };
const resource = { id: "demo", name: "Demo extension", scope: "project", source: "git:github.com/example/demo", enabled: true, extensionPaths: ["src/index.ts"] };
const response = (body: unknown) => ({ ok: true, json: async () => body });

describe("resource configuration refresh warnings", () => {
	it("reports a saved toggle with an incomplete session refresh and reloads the installed list", async () => {
		let enabled = true; let reads = 0;
		const changes: Record<string, unknown>[] = [];
		const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
			if (init?.method === "POST") {
				const payload = JSON.parse(String(init.body)); changes.push(payload); enabled = payload.enabled;
				return response({ success: true, data: { applied: true, warning: "One session is still using the previous resource configuration." } });
			}
			reads += 1;
			return response({ success: true, data: { packages: [{ ...resource, enabled }], views: enabled ? [view] : [], preferences: { renderers: {}, catalogUrls: [] }, hosts: [] } });
		});
		vi.stubGlobal("fetch", fetcher);
		render(<ResourceControls cwd="/workspace" />);
		const toggle = await screen.findByRole("switch", { name: resource.name });
		fireEvent.click(toggle);
		await waitFor(() => expect((screen.getByRole("switch", { name: resource.name }) as HTMLInputElement).checked).toBe(false));
		expect(changes).toEqual([{ action: "setEnabled", cwd: "/workspace", resourceId: "demo", scope: "project", enabled: false }]);
		expect(reads).toBe(2);
		expect(screen.getByRole("status").textContent).toContain("更改已保存，资源刷新失败，请重载会话。");
		expect(screen.getByRole("status").textContent).toContain("One session is still using the previous resource configuration.");
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("also reports a saved renderer preference and keeps the warning when the refreshed list is empty", async () => {
		let saved = false; let reads = 0;
		const changes: Record<string, unknown>[] = [];
		vi.stubGlobal("fetch", vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
			if (init?.method === "POST") {
				changes.push(JSON.parse(String(init.body))); saved = true;
				return response({ success: true, data: { applied: true, warning: "Session refresh did not finish." } });
			}
			reads += 1;
			return response({ success: true, data: { packages: [], views: saved ? [] : [view], preferences: { renderers: {}, catalogUrls: [] }, hosts: [] } });
		}));
		render(<ResourceControls cwd="/workspace" />);
		fireEvent.click(await screen.findByRole("button", { name: "默认交互界面 · select" }));
		fireEvent.click(screen.getByRole("option", { name: view.title }));
		await waitFor(() => expect(reads).toBe(2));
		expect(changes).toEqual([{ action: "preferences", cwd: "/workspace", preferences: { renderers: { select: view.id } } }]);
		expect(screen.getByRole("status").textContent).toContain("更改已保存");
		expect(screen.getByRole("status").textContent).toContain("Session refresh did not finish.");
	});

	it("distinguishes a rejected save from an applied change and does not imply success", async () => {
		let reads = 0;
		vi.stubGlobal("fetch", vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
			if (init?.method === "POST") return response({ success: false, error: "The resource configuration could not be saved." });
			reads += 1;
			return response({ success: true, data: { packages: [resource], views: [view], preferences: { renderers: {}, catalogUrls: [] } } });
		}));
		render(<ResourceControls cwd="/workspace" />);
		fireEvent.click(await screen.findByRole("switch", { name: resource.name }));
		await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("The resource configuration could not be saved."));
		expect(reads).toBe(1);
		expect((screen.getByRole("switch", { name: resource.name }) as HTMLInputElement).checked).toBe(true);
		expect(screen.queryByRole("status")).toBeNull();
	});

	it("clears an earlier partial-refresh warning after the next operation completes normally", async () => {
		let enabled = true; let mutations = 0;
		vi.stubGlobal("fetch", vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
			if (init?.method === "POST") {
				enabled = JSON.parse(String(init.body)).enabled;
				mutations += 1;
				return response(mutations === 1 ? { success: true, data: { applied: true, warning: "Refresh pending." } } : { success: true });
			}
			return response({ success: true, data: { packages: [{ ...resource, enabled }], views: enabled ? [view] : [], preferences: { renderers: {}, catalogUrls: [] } } });
		}));
		render(<ResourceControls cwd="/workspace" />);
		fireEvent.click(await screen.findByRole("switch", { name: resource.name }));
		await waitFor(() => expect((screen.getByRole("switch", { name: resource.name }) as HTMLInputElement).checked).toBe(false));
		expect(screen.getByRole("status")).toBeTruthy();
		fireEvent.click(screen.getByRole("switch", { name: resource.name }));
		await waitFor(() => expect((screen.getByRole("switch", { name: resource.name }) as HTMLInputElement).checked).toBe(true));
		expect(screen.queryByRole("status")).toBeNull();
	});
});
