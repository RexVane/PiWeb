import { beforeEach, expect, it, vi } from "vitest";
const deps = vi.hoisted(() => ({ scan: vi.fn(), run: vi.fn(), register: vi.fn() }));
vi.mock("@/lib/pi", () => ({ getAgentDir: () => "/test-agent" }));
vi.mock("@/lib/workspace-store", () => ({ registerCwds: deps.register }));
vi.mock("@/lib/session-import", () => ({ scanAllSources: deps.scan, importSessions: deps.run }));
import { GET, POST } from "@/app/api/sessions/import/route";
const report = { imported: 1, restored: 0, skipped: 0, failed: 0, results: [], workspaces: [] };
const request = (signal?: AbortSignal) => new Request("http://local/api/sessions/import", { method: "POST", headers: { Accept: "application/x-ndjson" }, body: JSON.stringify({ sessions: [{ source: "claude", externalId: "one" }] }), signal });
beforeEach(() => { vi.resetAllMocks(); });
it("forwards GET cancellation to source scans", async () => {
	deps.scan.mockResolvedValue({ imported: [], archived: [], summaries: [], errors: [], hasMore: {} });
	const req = new Request("http://local/api/sessions/import"); await GET(req);
	expect(deps.scan).toHaveBeenCalledWith("/test-agent", expect.objectContaining({ signal: req.signal }));
});
it("streams per-item progress before the final report is ready", async () => {
	let finish!: () => void;
	deps.run.mockImplementation(async (_items, options) => {
		options.onProgress(1, 1, { source: "claude", externalId: "one", status: "imported" });
		await new Promise<void>((resolve) => { finish = resolve; }); return report;
	});
	const response = await POST(request()); const reader = response.body!.getReader();
	expect(response.headers.get("Content-Type")).toContain("application/x-ndjson");
	expect(response.headers.get("Cache-Control")).toBe("no-store");
	expect(new TextDecoder().decode((await reader.read()).value)).toContain('"type":"progress"');
	finish(); expect(new TextDecoder().decode((await reader.read()).value)).toContain('"type":"result"');
	expect((await reader.read()).done).toBe(true);
});
it("aborts a pending import when the response reader cancels", async () => {
	let signal!: AbortSignal;
	deps.run.mockImplementation(async (_items, options) => {
		signal = options.signal; options.onProgress(0, 1);
		await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
	});
	const response = await POST(request()); const reader = response.body!.getReader(); await reader.read();
	await reader.cancel(); expect(signal.aborted).toBe(true);
});
it("sends an error event when an import fails after response headers", async () => {
	deps.run.mockRejectedValue(Object.assign(new Error("EACCES: source scan failed C:\\Users\\private\\source.jsonl"), { code: "EACCES" }));
	const response = await POST(request());
	const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
	expect(events[0]).toMatchObject({ type: "error", errorCode: "EACCES", error: "没有权限访问请求的资源。" });
	expect(events[1]).toMatchObject({ type: "result", success: false, data: { imported: 0, failed: 1, warning: "没有权限访问请求的资源。" } });
	expect(JSON.stringify(events)).not.toContain("private");
});

it("redacts source diagnostics in streamed progress and the final report while preserving the failure reason", async () => {
	const outcome = { source: "claude", externalId: "one", status: "failed", reason: "Malformed source at /private/source.jsonl", skipped: ["Broken block at C:\\Users\\private\\source.jsonl"] };
	deps.run.mockImplementation(async (_items, options) => { options.onProgress(1, 1, outcome); return { ...report, imported: 0, failed: 1, results: [outcome] }; });
	const events = (await (await POST(request())).text()).trim().split("\n").map((line) => JSON.parse(line));
	expect(events[0].outcome.reason).toContain("Malformed source");
	expect(events[1].data.results[0].skipped[0]).toContain("Broken block");
	expect(JSON.stringify(events)).not.toContain("private");
});
