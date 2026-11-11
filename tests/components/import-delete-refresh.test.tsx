// @vitest-environment jsdom
/** Real deletion hook and an open import panel; replace only HTTP responses. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { SessionImportSection } from "@/components/SessionImportSection";
import { usePiWeb } from "@/hooks/usePiWeb";

const response = (data: unknown) => new Response(JSON.stringify({ success: true, data }));
let imported: boolean;
let scanRequests: string[];
let posts: unknown[];
let deleteResponse: () => Promise<Response>;
let scanResponse: (url: string) => Promise<Response>;

function scanData() {
	return {
		sessions: [{ source: "claude", externalId: "restorable", title: "源会话", projectPath: "/ws" }],
		imported: imported ? ["claude:restorable"] : [], archived: [], errors: [], hasMore: { claude: true },
	};
}

beforeEach(() => {
	localStorage.clear();
	imported = true;
	scanRequests = [];
	posts = [];
	deleteResponse = async () => response({});
	scanResponse = async () => response(scanData());
	vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		if (url.startsWith("/api/sessions/import")) {
			if (init?.method === "POST") {
				posts.push(JSON.parse(String(init.body)));
				imported = true;
				return response({ imported: 1, skipped: 0, failed: 0, results: [], workspaces: ["/ws"] });
			}
			scanRequests.push(url);
			return scanResponse(url);
		}
		if (url.startsWith("/api/sessions/") && init?.method === "DELETE") {
			const result = await deleteResponse();
			if (result.ok) imported = false;
			return result;
		}
		return response(url === "/api/workspaces" ? { workspaces: ["/ws"] }
			: url === "/api/sessions" ? { sessions: [], running: {}, workspaceRegistry: { workspaces: [], removedWorkspaces: [], aliases: {}, archivedSessions: [] } }
			: url === "/api/models" ? { models: [], providers: [] } : {});
	}));
});
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); });

async function open() {
	const hook = renderHook(() => usePiWeb());
	render(<SessionImportSection cwd="/ws" />);
	await screen.findByTestId("import-group-claude");
	return hook;
}
const checkbox = () => screen.getByRole("checkbox") as HTMLInputElement;

it("refreshes after confirmed deletion and lets the same source session be imported again", async () => {
	const hook = await open();
	expect(checkbox().disabled).toBe(true);
	let resolve!: (value: Response) => void;
	deleteResponse = () => new Promise((done) => { resolve = done; });
	let deletion!: Promise<void>;
	act(() => { deletion = hook.result.current.deleteSession("/imported.jsonl"); });
	expect(checkbox().disabled).toBe(true);
	expect(scanRequests).toHaveLength(1);
	await act(async () => { resolve(response({})); await deletion; });
	await waitFor(() => expect(checkbox().disabled).toBe(false));
	expect(scanRequests).toHaveLength(2);
	fireEvent.click(checkbox());
	fireEvent.click(screen.getByTestId("import-run"));
	await waitFor(() => expect(posts).toHaveLength(1));
	expect(posts[0]).toMatchObject({ sessions: [{ source: "claude", externalId: "restorable" }] });
	await waitFor(() => expect(checkbox().disabled).toBe(true));
});

it("retains the imported state when deletion fails", async () => {
	const hook = await open();
	deleteResponse = async () => new Response(JSON.stringify({ success: false, error: "delete failed" }), { status: 503 });
	await act(async () => { await expect(hook.result.current.deleteSession("/imported.jsonl")).rejects.toThrow("delete failed"); });
	expect(checkbox().disabled).toBe(true);
	expect(scanRequests).toHaveLength(1);
	expect(hook.result.current.state.error).toBe("delete failed");
});

it("queues a refresh behind an older scan and keeps the expanded range", async () => {
	const hook = await open();
	const stale = response(scanData());
	let resolve!: (value: Response) => void;
	scanResponse = () => new Promise((done) => { resolve = done; });
	fireEvent.click(screen.getByTestId("import-load-more"));
	await waitFor(() => expect(scanRequests).toHaveLength(2));
	scanResponse = async () => response(scanData());
	await act(async () => { await hook.result.current.deleteSession("/imported.jsonl"); });
	expect(scanRequests).toHaveLength(2);
	await act(async () => resolve(stale));
	await waitFor(() => expect(checkbox().disabled).toBe(false));
	expect(scanRequests).toEqual(["/api/sessions/import", "/api/sessions/import?limit=100", "/api/sessions/import?limit=100"]);
});
