// @vitest-environment jsdom
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AddResourceMenu } from "@/components/resources/AddResourceMenu";
import { ResourceInstallModal } from "@/components/resources/ResourceInstallModal";
import { ResourceFrame } from "@/components/resources/ResourceFrame";
import { RESOURCE_FRAME_CHANNEL, type WebResourceView } from "@/lib/resources/protocol";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const view: WebResourceView = { id: "user:demo:main", resourceId: "demo", scope: "user", title: "Demo view", placement: "panel", methods: [], url: "/api/resources/views/abcd/assets/index.html" };

describe("resource adding flow", () => {
	it("opens exactly the two choices and invokes the selected action", () => {
		const install = vi.fn(); const design = vi.fn();
		render(<AddResourceMenu label="添加扩展" onInstall={install} onDesign={design} />);
		fireEvent.click(screen.getByRole("button", { name: /添加扩展/ }));
		expect(screen.getAllByRole("menuitem")).toHaveLength(2);
		fireEvent.click(screen.getByRole("menuitem", { name: /自己设计/ }));
		expect(design).toHaveBeenCalledTimes(1); expect(install).not.toHaveBeenCalled(); expect(screen.queryByRole("menu")).toBeNull();
	});
	it("actually starts a design session in the prepared workspace, once even in StrictMode", async () => {
		const calls: Array<Record<string, unknown>> = [];
		vi.stubGlobal("fetch", vi.fn(async (url, init) => {
			if (String(url) === "/api/resources/development") {
				calls.push(JSON.parse(init.body));
				return { ok: true, json: async () => ({ success: true, data: { prepared: { cwd: "/resources/new", name: "new", types: ["extensions"], compatibility: "unknown" }, prompt: "Read the public API and design this resource." } }) };
			}
			return { ok: true, json: async () => ({ success: true, data: { preferences: { developmentRoot: "/resources" } } }) };
		}));
		const start = vi.fn(async () => true); const close = vi.fn();
		render(<StrictMode><ResourceInstallModal open cwd="/workspace" mode="design" onClose={close} onSubmit={vi.fn()} onStartSession={start} /></StrictMode>);
		await waitFor(() => expect(start).toHaveBeenCalledWith("/resources/new", "Read the public API and design this resource."));
		expect(calls).toHaveLength(1); expect(close).toHaveBeenCalledTimes(1);
	});
	it("installs a direct Git source with the selected Pi scope without requesting a market index", async () => {
		const fetcher = vi.fn(async (_input: RequestInfo | URL) => ({ ok: true, json: async () => ({ success: true, data: { preferences: { renderers: {}, catalogUrls: [] } } }) }));
		vi.stubGlobal("fetch", fetcher);
		const install = vi.fn(async () => true);
		render(<ResourceInstallModal open cwd="/workspace" onClose={vi.fn()} onSubmit={install} />);
		fireEvent.change(screen.getByRole("textbox", { name: /npm \/ Git/ }), { target: { value: "git:github.com/example/demo" } });
		fireEvent.click(screen.getByRole("radio", { name: "仅当前工作区" }));
		fireEvent.click(screen.getByRole("button", { name: "安装" }));
		await waitFor(() => expect(install).toHaveBeenCalledWith("git:github.com/example/demo", true));
		expect(fetcher.mock.calls.some(([url]) => String(url).includes("market=1"))).toBe(false);
	});
	it.each([{ remote: true }, { browse: true }])("fills a local folder through the in-app fallback after %j", async (fallback) => {
		const basePath = "D:\\Packages";
		const packagePath = `${basePath}\\demo`;
		const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
			const request = JSON.parse(String(init?.body));
			const data = request.action === "pickDirectory" ? { path: null, canceled: false, ...fallback }
				: request.action === "roots" ? { roots: [] } : request.path === packagePath
				? { path: packagePath, parent: basePath, entries: [], truncated: false }
				: { path: basePath, parent: null, entries: [{ name: "demo", path: packagePath }], truncated: false };
			return { ok: true, json: async () => ({ success: true, data }) };
		});
		vi.stubGlobal("fetch", fetcher);
		const install = vi.fn(async () => true);
		const start = vi.fn(async () => true);
		render(<ResourceInstallModal open cwd="/workspace" onClose={vi.fn()} onSubmit={install} onStartSession={start} />);
		const input = screen.getByRole<HTMLInputElement>("textbox", { name: /npm \/ Git/ });
		const project = screen.getByRole<HTMLInputElement>("radio", { name: "仅当前工作区" });
		fireEvent.click(project);
		fireEvent.click(screen.getByRole("button", { name: "选择本地目录" }));
		expect(await screen.findByRole("dialog", { name: "选择本地目录" })).toBeTruthy();
		fireEvent.click(await screen.findByRole("button", { name: "demo" }));
		await screen.findByText(packagePath);
		fireEvent.click(screen.getByRole("button", { name: "选择此文件夹" }));
		expect(screen.queryByRole("dialog", { name: "选择本地目录" })).toBeNull();
		expect(input.value).toBe(packagePath);
		expect(project.checked).toBe(true);
		expect(fetcher.mock.calls.map(([url]) => url)).toEqual(["/api/workspaces", "/api/fs", "/api/fs", "/api/fs"]);
		expect(install).not.toHaveBeenCalled();
		expect(start).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "安装" }));
		await waitFor(() => expect(install).toHaveBeenCalledWith(packagePath, true));
	});
	it.each([
		{ directory: "D:\\Packages\\demo", expectedSource: "D:\\Packages\\demo" },
		{ directory: null, expectedSource: "https://github.com/example/demo" },
	])("uses the native picker result $directory without opening the in-app browser", async ({ directory, expectedSource }) => {
		const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => ({ ok: true, json: async () => ({ success: true, data: { path: directory, canceled: directory === null } }) }));
		vi.stubGlobal("fetch", fetcher);
		const install = vi.fn(async () => true);
		render(<ResourceInstallModal open cwd="/workspace" onClose={vi.fn()} onSubmit={install} />);
		const input = screen.getByRole<HTMLInputElement>("textbox", { name: /npm \/ Git/ });
		const pick = screen.getByRole<HTMLButtonElement>("button", { name: "选择本地目录" });
		fireEvent.change(input, { target: { value: "https://github.com/example/demo" } });
		fireEvent.click(pick);
		expect(pick.disabled).toBe(true);
		await waitFor(() => expect(pick.disabled).toBe(false));
		expect(input.value).toBe(expectedSource);
		expect(screen.queryByRole("dialog", { name: "选择本地目录" })).toBeNull();
		expect(fetcher.mock.calls.map(([url, init]) => [url, JSON.parse(String(init?.body))])).toEqual([["/api/workspaces", { action: "pickDirectory" }]]);
		expect(install).not.toHaveBeenCalled();
	});
	it("offers the Pi gallery as a link and keeps development actions collapsed on every open", () => {
		const props = { cwd: "/workspace", onClose: vi.fn(), onSubmit: vi.fn(), onStartSession: vi.fn() };
		const { rerender } = render(<ResourceInstallModal open {...props} />);
		const toggle = () => screen.getByRole("button", { name: "高级选项" });
		expect(screen.queryByRole("tablist")).toBeNull();
		const gallery = screen.getByRole("link", { name: "打开 Pi 官方包目录" });
		expect(gallery.getAttribute("href")).toBe("https://pi.dev/packages");
		expect(gallery.getAttribute("target")).toBe("_blank");
		expect(toggle().getAttribute("aria-expanded")).toBe("false");
		expect(screen.queryByRole("button", { name: "检查兼容性" })).toBeNull();
		expect(screen.queryByRole("button", { name: "开始适配" })).toBeNull();
		fireEvent.click(toggle());
		expect(toggle().getAttribute("aria-expanded")).toBe("true");
		expect(screen.getByRole("button", { name: "检查兼容性" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "开始适配" })).toBeTruthy();
		fireEvent.click(toggle());
		expect(screen.queryByRole("button", { name: "开始适配" })).toBeNull();
		fireEvent.click(toggle());
		rerender(<ResourceInstallModal open={false} {...props} />);
		rerender(<ResourceInstallModal open {...props} />);
		expect(toggle().getAttribute("aria-expanded")).toBe("false");
	});
	it.each([
		{ source: "https://github.com/example/demo", local: false, compatibility: "web", badge: "网页可用" },
		{ source: "git:github.com/example/demo@86a2ab4d45fd8c4ce80e9e8249af6c3248641125", local: false, compatibility: "web", badge: "网页可用" },
		{ source: "npm:@example/demo", local: true, compatibility: "adapt", badge: "需要网页适配" },
		{ source: "https://www.npmjs.com/package/demo", expectedSource: "npm:demo", local: false, compatibility: "web", badge: "网页可用" },
		{ source: "https://npmjs.com/package/@example/demo/v/1.2.3?activeTab=readme", expectedSource: "npm:@example/demo@1.2.3", local: true, compatibility: "adapt", badge: "需要网页适配" },
		{ source: "https://www.npmjs.com.example/package/demo", local: false, compatibility: "unknown", badge: "兼容性未确认" },
		{ source: "/original/local-demo", local: false, compatibility: "unknown", badge: "兼容性未确认" },
	])("uses the same package source for inspecting and installing $source", async ({ source, expectedSource = source, local, compatibility, badge }) => {
		const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => ({ ok: true, json: async () => ({ success: true, data: {
			prepared: { cwd: "/resources/preview-copy", source, name: "Demo", types: ["extensions"], compatibility, installSource: "/resources/preview-copy" },
		} }) }));
		vi.stubGlobal("fetch", fetcher);
		const install = vi.fn(async () => true);
		const start = vi.fn(async () => true);
		render(<ResourceInstallModal open cwd="/workspace" onClose={vi.fn()} onSubmit={install} onStartSession={start} />);
		fireEvent.change(screen.getByRole("textbox", { name: /npm \/ Git/ }), { target: { value: source } });
		if (local) fireEvent.click(screen.getByRole("radio", { name: "仅当前工作区" }));
		fireEvent.click(screen.getByRole("button", { name: "高级选项" }));
		fireEvent.click(screen.getByRole("button", { name: "检查兼容性" }));
		await screen.findByText(badge);
		expect(fetcher.mock.calls.filter(([url]) => url === "/api/resources/development").map(([, init]) => JSON.parse(String(init?.body)))).toEqual([{ action: "inspect", source: expectedSource }]);
		fireEvent.click(screen.getByRole("button", { name: "安装" }));
		await waitFor(() => expect(install).toHaveBeenCalledWith(expectedSource, local));
		expect(start).not.toHaveBeenCalled();
	});
	it("starts adaptation from the advanced panel without submitting the install form", async () => {
		const source = "git:github.com/example/demo";
		const prepared = { cwd: "/resources/demo", source, name: "Demo", types: ["extensions"], compatibility: "adapt" };
		const prompt = "Adapt the extension in its own workspace.";
		const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => ({ ok: true, json: async () => ({ success: true, data: { prepared, prompt } }) }));
		vi.stubGlobal("fetch", fetcher);
		const install = vi.fn(async () => true);
		const start = vi.fn(async () => true);
		render(<ResourceInstallModal open cwd="/workspace" onClose={vi.fn()} onSubmit={install} onStartSession={start} />);
		fireEvent.change(screen.getByRole("textbox", { name: /npm \/ Git/ }), { target: { value: source } });
		fireEvent.click(screen.getByRole("button", { name: "高级选项" }));
		fireEvent.click(screen.getByRole("button", { name: "开始适配" }));
		await waitFor(() => expect(start).toHaveBeenCalledWith(prepared.cwd, prompt));
		expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({ action: "adapt", source });
		expect(install).not.toHaveBeenCalled();
	});
});

describe("independent browser frame", () => {
	it("is opaque-origin and accepts messages only from its own frame with the issued token", async () => {
		const answer = vi.fn();
		const { container } = render(<ResourceFrame view={view} cwd="/workspace" onAnswer={answer} />);
		const frame = container.querySelector("iframe")!;
		expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
		const post = vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation(() => {});
		fireEvent(window, new MessageEvent("message", { data: { channel: RESOURCE_FRAME_CHANNEL, type: "ready" }, source: frame.contentWindow! }));
		await waitFor(() => expect(post).toHaveBeenCalled());
		const token = (post.mock.calls[0][0] as { token: string }).token;
		fireEvent(window, new MessageEvent("message", { data: { channel: RESOURCE_FRAME_CHANNEL, type: "answer", token: "wrong", value: "bad" }, source: frame.contentWindow! }));
		fireEvent(window, new MessageEvent("message", { data: { channel: RESOURCE_FRAME_CHANNEL, type: "answer", token, value: "foreign" }, source: window }));
		expect(answer).not.toHaveBeenCalled();
		fireEvent(window, new MessageEvent("message", { data: { channel: RESOURCE_FRAME_CHANNEL, type: "answer", token, value: "A" }, source: frame.contentWindow! }));
		expect(answer).toHaveBeenCalledWith("A");
	});
	it("never calls backend actions or returns an approval from passive preview", async () => {
		const fetcher = vi.fn(); const answer = vi.fn(); vi.stubGlobal("fetch", fetcher);
		const { container } = render(<ResourceFrame view={{ ...view, preview: true }} cwd="/workspace" onAnswer={answer} />);
		const frame = container.querySelector("iframe")!;
		const post = vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation(() => {});
		fireEvent(window, new MessageEvent("message", { data: { channel: RESOURCE_FRAME_CHANNEL, type: "ready" }, source: frame.contentWindow! }));
		await waitFor(() => expect(post).toHaveBeenCalled());
		const token = (post.mock.calls[0][0] as { token: string }).token;
		fireEvent(window, new MessageEvent("message", { data: { channel: RESOURCE_FRAME_CHANNEL, type: "invoke", token, id: "preview-call", name: "run", args: {} }, source: frame.contentWindow! }));
		fireEvent(window, new MessageEvent("message", { data: { channel: RESOURCE_FRAME_CHANNEL, type: "answer", token, value: true }, source: frame.contentWindow! }));
		expect(fetcher).not.toHaveBeenCalled(); expect(answer).not.toHaveBeenCalled();
		expect(post.mock.calls.some(([message]) => (message as { error?: string }).error?.includes("Passive preview"))).toBe(true);
	});
	it("replaces the document when resource identity changes instead of reusing an old window", () => {
		const { container, rerender } = render(<ResourceFrame view={view} cwd="/workspace" />);
		const previous = container.querySelector("iframe");
		rerender(<ResourceFrame view={{ ...view, id: "user:other:main", resourceId: "other", url: "/api/resources/views/efgh/assets/index.html" }} cwd="/workspace" />);
		expect(container.querySelector("iframe")).not.toBe(previous);
	});
	it("does not load an external URL or automatically approve when a view fails", () => {
		const answer = vi.fn(); const fallback = vi.fn();
		const { container } = render(<ResourceFrame view={{ ...view, url: "https://evil.example/view" }} cwd="/workspace" onAnswer={answer} onUnavailable={fallback} />);
		expect(container.querySelector("iframe")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "使用基础界面" }));
		expect(fallback).toHaveBeenCalledTimes(1); expect(answer).not.toHaveBeenCalled();
	});
	it("fetches user-scoped resources even when no active workspace cwd is selected", async () => {
		const { useResourceRegistry } = await import("@/hooks/useResourceRegistry");
		const fetcher = vi.fn(async () => ({
			ok: true,
			json: async () => ({
				success: true,
				data: {
					packages: [],
					views: [view],
					preferences: { catalogUrls: [], renderers: {} },
					hosts: [],
				},
			}),
		}));
		vi.stubGlobal("fetch", fetcher);
		function Probe() {
			const registry = useResourceRegistry("");
			return <span>{registry.views.map((item) => item.id).join(",")}</span>;
		}
		render(<Probe />);
		await waitFor(() => expect(screen.getByText(view.id)).toBeTruthy());
		expect(fetcher).toHaveBeenCalledWith("/api/resources", expect.anything());
	});
	it("applies whitelisted PiWeb theme variables with digits and non-dsw prefixes in client.js", async () => {
		const { readFileSync } = await import("node:fs");
		const path = await import("node:path");
		const script = readFileSync(path.resolve("public/resources/client.js"), "utf8");
		vi.spyOn(window, "postMessage").mockImplementation(() => {});
		new Function(script)();
		fireEvent(window, new MessageEvent("message", {
			source: window,
			data: {
				channel: RESOURCE_FRAME_CHANNEL,
				token: "tok-theme",
				type: "context",
				context: { viewId: view.id, resourceId: view.resourceId, scope: "user", cwd: "" },
				language: "zh",
				theme: {
					"--dsw-border-l2": "#d1d5db",
					"--dsh-ui-font-sm": "13px",
					"--pw-radius-panel": "24px",
					"--isx-ease": "ease",
					"--ds-duration-fast": "120ms",
					"--font-mono": "monospace",
					"--evil-private": "ignored",
				},
			},
		}));
		expect(document.documentElement.style.getPropertyValue("--dsw-border-l2")).toBe("#d1d5db");
		expect(document.documentElement.style.getPropertyValue("--dsh-ui-font-sm")).toBe("13px");
		expect(document.documentElement.style.getPropertyValue("--pw-radius-panel")).toBe("24px");
		expect(document.documentElement.style.getPropertyValue("--isx-ease")).toBe("ease");
		expect(document.documentElement.style.getPropertyValue("--ds-duration-fast")).toBe("120ms");
		expect(document.documentElement.style.getPropertyValue("--font-mono")).toBe("monospace");
		expect(document.documentElement.style.getPropertyValue("--evil-private")).toBe("");
	});
});
