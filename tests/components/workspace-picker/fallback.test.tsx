// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { usePiWeb } from "@/hooks/usePiWeb";
import { DirectoryPicker } from "@/components/DirectoryPicker";

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	localStorage.clear();
});

function Harness() {
	const pi = usePiWeb();
	const [result, setResult] = useState("waiting");
	return <>
		<button onClick={() => void pi.addWorkspaceByPicker().then((value) => setResult(value ?? "canceled"))}>添加工作区</button>
		<output aria-label="选择结果">{result}</output>
		<output aria-label="工作区">{pi.addedWorkspaces.join(",")}</output>
		<output aria-label="错误">{pi.state.error}</output>
		<DirectoryPicker open={pi.dirPickerOpen} onConfirm={(value) => void pi.confirmDirPicker(value)} onCancel={pi.cancelDirPicker} />
	</>;
}

function setup(picker: Record<string, unknown>) {
	const registry = { workspaces: [] as string[], removedWorkspaces: [], aliases: {}, archivedSessions: [] };
	const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		const body = init?.body ? JSON.parse(String(init.body)) : {};
		let data: unknown;
		if (url === "/api/sessions") data = { sessions: [], running: {}, workspaceRegistry: registry };
		else if (url === "/api/models") data = { providers: [], models: [] };
		else if (url === "/api/workspaces") {
			if (body.action === "pick") data = picker;
			else {
				if (body.action === "add") registry.workspaces = [body.path];
				data = registry;
			}
		} else if (url === "/api/fs") {
			data = body.action === "roots" ? { roots: [{ name: "测试目录", path: "/tmp/project" }] }
				: { path: body.path ?? "/tmp", parent: "/", entries: [], truncated: false };
		} else throw new Error(`unexpected request: ${url}`);
		return new Response(JSON.stringify({ success: true, data }), { headers: { "Content-Type": "application/json" } });
	});
	vi.stubGlobal("fetch", fetchMock);
	render(<Harness />);
	fireEvent.click(screen.getByRole("button", { name: "添加工作区" }));
	return fetchMock;
}

it.each([{ browse: true }, { remote: true }])("page picker can finish adding a workspace after %j", async (reason) => {
	setup({ path: null, canceled: false, ...reason });
	fireEvent.click(await screen.findByRole("button", { name: "测试目录" }));
	await waitFor(() => expect(screen.getByText("/tmp/project")).toBeTruthy());
	fireEvent.click(screen.getByRole("button", { name: "选择此文件夹" }));
	await waitFor(() => expect(screen.getByLabelText("选择结果").textContent).toBe("/tmp/project"));
	expect(screen.getByLabelText("工作区").textContent).toBe("/tmp/project");
	expect(screen.queryByText("选择工作区文件夹")).toBeNull();
	expect(screen.getByLabelText("错误").textContent).toBe("");
});

it("canceling the fallback settles the pending caller without adding a workspace", async () => {
	const fetchMock = setup({ path: null, canceled: false, browse: true });
	fireEvent.click(await screen.findByRole("button", { name: "取消" }));
	await waitFor(() => expect(screen.getByLabelText("选择结果").textContent).toBe("canceled"));
	expect(fetchMock.mock.calls.some(([, init]) => init?.body && JSON.parse(String(init.body)).action === "add")).toBe(false);
	expect(screen.getByLabelText("工作区").textContent).toBe("");
});

it("native cancellation ends the action without a fallback or error", async () => {
	setup({ path: null, canceled: true });
	await waitFor(() => expect(screen.getByLabelText("选择结果").textContent).toBe("canceled"));
	expect(screen.queryByText("选择工作区文件夹")).toBeNull();
	expect(screen.getByLabelText("错误").textContent).toBe("");
});
