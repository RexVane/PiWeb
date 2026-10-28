// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DirectoryPicker } from "@/components/DirectoryPicker";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const listing = (path: string) => ({ path, parent: "/", entries: [], truncated: false });
const response = (data: unknown) => ({ ok: true, json: async () => ({ success: true, data }) });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }

describe("DirectoryPicker requests and keyboard", () => {
	it("keeps the newest directory when earlier requests finish later", async () => {
		const a = deferred<ReturnType<typeof response>>();
		const b = deferred<ReturnType<typeof response>>();
		vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => {
			const body = JSON.parse(String(init.body));
			if (body.action === "roots") return Promise.resolve(response({ roots: [{ name: "A", path: "/A" }, { name: "B", path: "/B" }] }));
			if (body.path === "/A") return a.promise;
			if (body.path === "/B") return b.promise;
			return Promise.resolve(response(listing("/home")));
		}));
		const onConfirm = vi.fn();
		render(<DirectoryPicker open onConfirm={onConfirm} onCancel={vi.fn()} />);
		await screen.findByTitle("/home");
		fireEvent.click(screen.getByRole("button", { name: "A" }));
		fireEvent.click(screen.getByRole("button", { name: "B" }));
		await act(async () => { b.resolve(response(listing("/B"))); });
		await screen.findByText("/B");
		await act(async () => { a.resolve(response(listing("/A"))); });
		expect(screen.queryByText("/A")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "选择此文件夹" }));
		expect(onConfirm).toHaveBeenCalledWith("/B");
	});

	it("closes with Escape and exposes a named dialog", () => {
		vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
		const onCancel = vi.fn();
		render(<DirectoryPicker open onConfirm={vi.fn()} onCancel={onCancel} />);
		fireEvent.keyDown(document, { key: "Escape" });
		expect(onCancel).toHaveBeenCalledTimes(1);
		expect(screen.getByRole("dialog").getAttribute("aria-modal")).toBe("true");
	});

	it("does not start a listing after the closed dialog's roots request finishes", async () => {
		const roots = deferred<ReturnType<typeof response>>();
		const fetcher = vi.fn(() => roots.promise);
		vi.stubGlobal("fetch", fetcher);
		const props = { onConfirm: vi.fn(), onCancel: vi.fn() };
		const { rerender } = render(<DirectoryPicker {...props} open />);
		rerender(<DirectoryPicker {...props} open={false} />);
		await act(async () => { roots.resolve(response({ roots: [] })); });
		await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
	});
});
