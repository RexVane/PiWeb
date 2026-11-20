// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PromptTemplatesSection } from "@/components/settings/PromptTemplatesSection";
import { PromptTemplatesWorkspaceView } from "@/components/workspace/PromptTemplatesWorkspaceView";
import type { PromptTemplateView } from "@/lib/prompt-template-view";

const review: PromptTemplateView = { name: "review", description: "Review staged code", argumentHint: "[focus]", filePath: "/agent/prompts/review.md", scope: "user", origin: "top-level", sourceLabel: "~/.pi/agent", disabled: false, canToggle: true, canDelete: true };
const packaged: PromptTemplateView = { ...review, name: "lint", description: "Check for lint errors", filePath: "/packages/check/prompts/lint.md", origin: "package", sourceLabel: "check-package", disabled: true, canDelete: false };
const project = (cwd: string): PromptTemplateView => ({ ...review, name: "deploy", scope: "project", filePath: `${cwd}/.pi/prompts/deploy.md` });
const response = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("PromptTemplatesSection", () => {
	it("shows source, command arguments, disabled templates and search results", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => response({ templates: [review, packaged] })));
		render(<PromptTemplatesSection cwd="/ws" />);
		await screen.findByText("review");
		expect(screen.getByText("/review [focus]")).toBeTruthy();
		expect(screen.getByText("来源: check-package")).toBeTruthy();
		expect(screen.getByRole("switch", { name: "lint" }).getAttribute("aria-checked")).toBe("false");
		expect(screen.getAllByRole("button", { name: "删除" })).toHaveLength(1);
		fireEvent.change(screen.getByRole("searchbox"), { target: { value: "/review" } });
		expect(screen.queryByText("lint")).toBeNull();
		expect(screen.getByText("review")).toBeTruthy();
	});

	it("sends template toggles using the official resource file path", async () => {
		const posts: unknown[] = [];
		vi.stubGlobal("fetch", vi.fn(async (_url, init?: RequestInit) => {
			if (init?.method === "POST") { posts.push(JSON.parse(String(init.body))); return response({ changed: true }); }
			return response({ templates: [review] });
		}));
		render(<PromptTemplatesSection cwd="/ws" />);
		fireEvent.click(await screen.findByRole("switch", { name: "review" }));
		await waitFor(() => expect(posts).toEqual([{ action: "toggle", filePath: review.filePath, disabled: true, cwd: "/ws" }]));
	});

	it("opens the original Markdown file on demand", async () => {
		const open = vi.fn();
		vi.stubGlobal("fetch", vi.fn(async (_url, init?: RequestInit) => init?.method === "POST" ? response({ content: "---\ndescription: Test\n---\nPrompt $1" }) : response({ templates: [review] })));
		render(<PromptTemplatesSection cwd="/ws" onOpenFileContent={open} />);
		fireEvent.click(await screen.findByRole("button", { name: "查看模板" }));
		await waitFor(() => expect(open).toHaveBeenCalledWith(review.filePath, "---\ndescription: Test\n---\nPrompt $1", "/ws"));
	});

	it("previews removal, confirms the exact file, and does not remove its directory", async () => {
		const posts: Record<string, unknown>[] = [];
		let templates = [review];
		vi.stubGlobal("fetch", vi.fn(async (_url, init?: RequestInit) => {
			if (init?.method === "POST") {
				const body = JSON.parse(String(init.body)); posts.push(body);
				if (body.action === "previewDelete") return response({ removed: review.filePath, link: false });
				templates = []; return response({ removed: review.filePath });
			}
			return response({ templates });
		}));
		render(<PromptTemplatesSection cwd="/ws" />);
		fireEvent.click(await screen.findByRole("button", { name: "删除" }));
		const dialog = await screen.findByRole("alertdialog");
		expect(posts.map((post) => post.action)).toEqual(["previewDelete"]);
		expect(dialog.textContent).toContain(review.filePath);
		expect(dialog.textContent).toContain("系统回收站");
		expect(dialog.textContent).not.toContain("恢复副本");
		fireEvent.click(within(dialog).getByRole("button", { name: "删除" }));
		await waitFor(() => expect(posts[1]).toEqual({ action: "delete", filePath: review.filePath, expectedPath: review.filePath, cwd: "/ws" }));
		await waitFor(() => expect(screen.queryByText("review")).toBeNull());
	});

	it("cancels confirmed deletion without submitting a delete request", async () => {
		const posts: Record<string, unknown>[] = [];
		vi.stubGlobal("fetch", vi.fn(async (_url, init?: RequestInit) => {
			if (init?.method === "POST") { posts.push(JSON.parse(String(init.body))); return response({ removed: review.filePath }); }
			return response({ templates: [review] });
		}));
		render(<PromptTemplatesSection cwd="/ws" />);
		fireEvent.click(await screen.findByRole("button", { name: "删除" }));
		fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "取消" }));
		await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
		expect(posts.map((post) => post.action)).toEqual(["previewDelete"]);
		expect(screen.getByText("review")).toBeTruthy();
	});

	it("shows the Trash failure and keeps the template available for retry", async () => {
		vi.stubGlobal("fetch", vi.fn(async (_url, init?: RequestInit) => {
			if (init?.method === "POST") {
				if (JSON.parse(String(init.body)).action === "previewDelete") return response({ removed: review.filePath });
				return new Response(JSON.stringify({ success: false, errorCode: "TRASH_UNAVAILABLE", error: "recycler unavailable" }), { status: 500 });
			}
			return response({ templates: [review] });
		}));
		render(<PromptTemplatesSection cwd="/ws" />);
		fireEvent.click(await screen.findByRole("button", { name: "删除" }));
		fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "删除" }));
		expect((await screen.findByRole("alert")).textContent).toContain("未执行永久删除");
		expect(screen.getByText("review")).toBeTruthy();
		expect((screen.getByRole("button", { name: "删除" }) as HTMLButtonElement).disabled).toBe(false);
	});

	it("keeps project scope and workspace controls available on an empty page", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => response({ templates: [] })));
		const onCwdChange = vi.fn();
		render(<PromptTemplatesSection cwd="/a" workspaceOptions={[{ value: "/a", label: "A" }, { value: "/b", label: "B" }]} onCwdChange={onCwdChange} />);
		await screen.findByText("暂无提示词模板");
		fireEvent.click(screen.getByRole("tab", { name: /项目/ }));
		fireEvent.click(screen.getByRole("button", { name: "当前工作区" }));
		fireEvent.click(await screen.findByRole("option", { name: "B" }));
		expect(onCwdChange).toHaveBeenCalledWith("/b");
	});

	it("ignores an older list response after changing workspace", async () => {
		const old = deferred<Response>();
		vi.stubGlobal("fetch", vi.fn((url: string) => url.includes("cwd=%2Fa") ? old.promise : Promise.resolve(response({ templates: [project("/b")] }))));
		const { rerender } = render(<PromptTemplatesSection cwd="/a" />);
		rerender(<PromptTemplatesSection cwd="/b" />);
		await screen.findByText("deploy");
		await act(async () => { old.resolve(response({ templates: [review] })); });
		expect(screen.queryByText("review")).toBeNull();
		expect(screen.getByText("deploy")).toBeTruthy();
	});

	it("does not open a read response from the previous workspace", async () => {
		const read = deferred<Response>();
		const open = vi.fn();
		vi.stubGlobal("fetch", vi.fn((_url, init?: RequestInit) => init?.method === "POST" ? read.promise : Promise.resolve(response({ templates: [review] }))));
		const { rerender } = render(<PromptTemplatesSection cwd="/a" onOpenFileContent={open} />);
		fireEvent.click(await screen.findByRole("button", { name: "查看模板" }));
		rerender(<PromptTemplatesSection cwd="/b" onOpenFileContent={open} />);
		await act(async () => { read.resolve(response({ content: "old file" })); });
		expect(open).not.toHaveBeenCalled();
	});

	it("does not submit an obsolete removal confirmation after changing workspace", async () => {
		const actions: string[] = [];
		vi.stubGlobal("fetch", vi.fn(async (_url, init?: RequestInit) => {
			if (init?.method === "POST") { actions.push(JSON.parse(String(init.body)).action); return response({ removed: review.filePath }); }
			return response({ templates: [review] });
		}));
		const { rerender } = render(<PromptTemplatesSection cwd="/a" />);
		fireEvent.click(await screen.findByRole("button", { name: "删除" }));
		const dialog = await screen.findByRole("alertdialog");
		rerender(<PromptTemplatesSection cwd="/b" />);
		fireEvent.click(within(dialog).getByRole("button", { name: "删除" }));
		await act(async () => {});
		expect(actions).toEqual(["previewDelete"]);
	});

	it("shows operation errors and re-enables controls for retry", async () => {
		vi.stubGlobal("fetch", vi.fn(async (_url, init?: RequestInit) => {
			if (init?.method === "POST") throw new Error("template network failed");
			return response({ templates: [review] });
		}));
		render(<PromptTemplatesSection cwd="/ws" />);
		fireEvent.click(await screen.findByRole("switch", { name: "review" }));
		expect((await screen.findByRole("alert")).textContent).toContain("template network failed");
		expect((screen.getByRole("switch", { name: "review" }) as HTMLButtonElement).disabled).toBe(false);
	});

	it("retains the localized saved-change warning after refreshing", async () => {
		vi.stubGlobal("fetch", vi.fn(async (_url, init?: RequestInit) => init?.method === "POST" ? response({ changed: true, warning: "saved, refresh failed" }) : response({ templates: [review] })));
		render(<PromptTemplatesSection cwd="/ws" />);
		fireEvent.click(await screen.findByRole("switch", { name: "review" }));
		expect((await screen.findByRole("alert")).textContent).toContain("更改已保存");
	});

	it("does not restore deleted templates from an earlier refresh", async () => {
		const old = deferred<Response>();
		let reads = 0;
		let deleted = false;
		vi.stubGlobal("fetch", vi.fn(async (_url, init?: RequestInit) => {
			if (init?.method === "POST") {
				if (JSON.parse(String(init.body)).action === "previewDelete") return response({ removed: review.filePath });
				deleted = true; return response({});
			}
			reads += 1;
			if (reads === 2) return old.promise;
			return response({ templates: deleted ? [] : [review] });
		}));
		const { rerender } = render(<PromptTemplatesSection cwd="/ws" />);
		await screen.findByText("review");
		rerender(<PromptTemplatesSection cwd="/ws" reloadSeq={1} />);
		await waitFor(() => expect(reads).toBe(2));
		fireEvent.click(screen.getByRole("button", { name: "删除" }));
		fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "删除" }));
		await waitFor(() => expect(screen.queryByText("review")).toBeNull());
		await act(async () => { old.resolve(response({ templates: [review] })); });
		expect(screen.queryByText("review")).toBeNull();
	});

	it("uses the selected project in the workspace page and supports manual refresh", async () => {
		const posts: Record<string, unknown>[] = [];
		const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
			if (init?.method === "POST") { posts.push(JSON.parse(String(init.body))); return response({ changed: true }); }
			const cwd = new URL(url, "http://localhost").searchParams.get("cwd") || "";
			return response({ templates: [project(cwd)] });
		});
		vi.stubGlobal("fetch", fetchMock);
		render(<PromptTemplatesWorkspaceView knownCwds={["/a", "/b"]} defaultCwd="/a" getWorkspaceName={(cwd) => cwd} />);
		await screen.findByText("deploy");
		fireEvent.click(screen.getByRole("tab", { name: /项目/ }));
		fireEvent.click(screen.getByRole("button", { name: "当前工作区" }));
		fireEvent.click(await screen.findByRole("option", { name: "/b" }));
		await screen.findByText("/b/.pi/prompts/deploy.md");
		fireEvent.click(screen.getByRole("switch", { name: "deploy" }));
		await waitFor(() => expect(posts[0]).toMatchObject({ action: "toggle", cwd: "/b", filePath: "/b/.pi/prompts/deploy.md" }));
		await waitFor(() => expect((screen.getByRole("switch", { name: "deploy" }) as HTMLButtonElement).disabled).toBe(false));
		const before = fetchMock.mock.calls.length;
		fireEvent.click(screen.getByRole("button", { name: "刷新" }));
		await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(before));
	});
});
