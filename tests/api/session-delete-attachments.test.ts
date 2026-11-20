import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { recycleGeneratedFixture } from "../fixtures/system-trash";

/** Real route, session boundaries and upload reference scans; only the OS Trash is simulated. */
const state = vi.hoisted(() => ({
	trash: "", failPath: "", moved: [] as Array<{ original: string; destination: string }>,
	dispose: vi.fn(async (_path: string) => {}),
}));
vi.mock("@/lib/agent-manager", () => ({ disposeSessionPath: state.dispose, getManaged: vi.fn(), getSessionHistory: vi.fn(), syncSessionsFromDisk: vi.fn() }));
vi.mock("@/lib/recycle-bin", () => ({ moveToTrash: async (removed: string) => {
	if (removed === state.failPath) throw Object.assign(new Error("native recycler unavailable"), { code: "TRASH_UNAVAILABLE" });
	const destination = path.join(state.trash, `${randomUUID()}-${path.basename(removed)}`);
	await fs.rename(removed, destination); state.moved.push({ original: removed, destination }); return { removed };
} }));

let group: string, directory: string, agentDir: string, uploads: string, sessionA: string, sessionB: string;
let DELETE: typeof import("../../src/app/api/sessions/[id]/route")["DELETE"];
let encodeSessionId: typeof import("../../src/lib/pi")["encodeSessionId"];
const line = (entry: unknown) => `${JSON.stringify(entry)}\n`;
const header = () => line({ type: "session", version: 3, id: "s", timestamp: "2026-01-01T00:00:00.000Z", cwd: "D:\\Proj" });
const message = (text: string) => line({ type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text }], timestamp: 1767225601000 } });
async function putUpload(name: string, body: string): Promise<string> {
	const file = path.join(uploads, name); await fs.writeFile(file, body); return file;
}
const recycledPath = (file: string) => state.moved.find((entry) => entry.original === file)!.destination;
async function remove(file: string): Promise<Response> {
	const id = encodeSessionId(file);
	return DELETE(new Request(`http://localhost/api/sessions/${id}`, { method: "DELETE" }), { params: Promise.resolve({ id }) });
}
beforeAll(async () => {
	group = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "piweb-delete-trash-fixtures-")));
	vi.stubEnv("PI_CODING_AGENT_DIR", path.join(group, "initial-agent")); vi.stubEnv("HOME", group); vi.stubEnv("USERPROFILE", group);
	({ DELETE } = await import("../../src/app/api/sessions/[id]/route"));
	({ encodeSessionId } = await import("../../src/lib/pi"));
});
beforeEach(async () => {
	directory = await fs.mkdtemp(path.join(group, "case-")); agentDir = path.join(directory, "agent"); uploads = path.join(agentDir, "web-uploads");
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir); vi.stubEnv("HOME", directory); vi.stubEnv("USERPROFILE", directory);
	vi.stubEnv("PI_OFFLINE", "1"); vi.stubEnv("PI_WEB_UPDATE_CHECK", "0");
	state.trash = path.join(directory, "test-system-trash"); state.failPath = ""; state.moved = []; state.dispose.mockClear();
	for (const root of [path.join(agentDir, "sessions", "workspace"), uploads, state.trash]) await fs.mkdir(root, { recursive: true });
	sessionA = path.join(agentDir, "sessions", "workspace", "delete-me.jsonl"); sessionB = path.join(agentDir, "sessions", "workspace", "keep-me.jsonl");
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
afterAll(async () => { vi.unstubAllEnvs(); await recycleGeneratedFixture(group); });

describe("confirmed session deletion and its orphaned uploads use the system Trash", () => {
	it("recycles the record and its exclusive attachments, keeping shared and unrelated uploads", async () => {
		const shared = await putUpload("shared-report.txt", "SHARED-BODY");
		const orphan = await putUpload("orphan-only-here.txt", "ORPHAN-BODY");
		const unrelated = await putUpload("another-sessions-upload.txt", "UNRELATED-BODY");
		const original = header() + message(`附件 ${orphan} 和 ${shared}`);
		await fs.writeFile(sessionA, original); await fs.writeFile(sessionB, header() + message(`继续用 ${shared}`));
		const response = await remove(sessionA);
		expect(response.status).toBe(200); expect(await response.json()).toEqual({ success: true });
		expect(await fs.readFile(recycledPath(sessionA), "utf8")).toBe(original);
		expect(await fs.readFile(recycledPath(orphan), "utf8")).toBe("ORPHAN-BODY");
		await expect(fs.stat(sessionA)).rejects.toMatchObject({ code: "ENOENT" });
		await expect(fs.stat(orphan)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await fs.readFile(shared, "utf8")).toBe("SHARED-BODY"); expect(await fs.readFile(unrelated, "utf8")).toBe("UNRELATED-BODY");
		await expect(fs.stat(path.join(directory, ".agents", "backups"))).rejects.toMatchObject({ code: "ENOENT" });
		expect(state.dispose).toHaveBeenCalledWith(sessionA);
	});

	it("recycles a freshly uploaded exclusive attachment without the retention grace period", async () => {
		const fresh = await putUpload("fresh.bin", "FRESH"); await fs.writeFile(sessionA, header() + message(`看图 ${fresh}`));
		expect((await remove(sessionA)).status).toBe(200); expect(await fs.readFile(recycledPath(fresh), "utf8")).toBe("FRESH");
	});

	it("keeps attachments when PI_WEB_DELETE_ATTACHMENT_CLEANUP=0", async () => {
		const orphan = await putUpload("keep.txt", "KEEP"); await fs.writeFile(sessionA, header() + message(`附件 ${orphan}`));
		vi.stubEnv("PI_WEB_DELETE_ATTACHMENT_CLEANUP", "0");
		expect((await remove(sessionA)).status).toBe(200); expect(await fs.readFile(orphan, "utf8")).toBe("KEEP");
		expect(state.moved.map((entry) => entry.original)).toEqual([sessionA]);
	});

	it("keeps attachments when other session references cannot be inventoried completely", async () => {
		const orphan = await putUpload("must-stay.txt", "SAFE"); await fs.writeFile(sessionA, header() + message(`附件 ${orphan}`));
		await fs.mkdir(path.join(agentDir, "sessions", "workspace", "broken.jsonl"));
		expect((await remove(sessionA)).status).toBe(200); expect(await fs.readFile(orphan, "utf8")).toBe("SAFE");
		expect(state.moved.map((entry) => entry.original)).toEqual([sessionA]);
	});

	it("recycles a plain-text session with no uploads", async () => {
		await fs.writeFile(sessionA, header() + message("纯文本会话"));
		expect((await remove(sessionA)).status).toBe(200); expect(state.moved.map((entry) => entry.original)).toEqual([sessionA]);
	});

	it("retains the session, uploads and archive metadata when the system Trash is unavailable", async () => {
		const orphan = await putUpload("exclusive.txt", "EXCLUSIVE"); const original = header() + message(orphan);
		await fs.writeFile(sessionA, original);
		const registry = path.join(agentDir, "web-workspaces.json"), stored = JSON.stringify({ workspaces: [], archivedSessions: [sessionA] });
		await fs.writeFile(registry, stored); state.failPath = sessionA;
		const response = await remove(sessionA);
		expect(response.status).toBe(500); expect(await response.json()).toMatchObject({ success: false, errorCode: "TRASH_UNAVAILABLE" });
		expect(await fs.readFile(sessionA, "utf8")).toBe(original); expect(await fs.readFile(orphan, "utf8")).toBe("EXCLUSIVE");
		expect(await fs.readFile(registry, "utf8")).toBe(stored); expect(state.moved).toEqual([]);
	});

	it("reports partial cleanup instead of claiming that a recycled record is still in place", async () => {
		const orphan = await putUpload("retained-upload.txt", "RETAIN"); await fs.writeFile(sessionA, header() + message(orphan));
		state.failPath = orphan;
		const response = await remove(sessionA);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ success: true, data: { warningCode: "SESSION_DELETE_PARTIAL", warning: expect.stringContaining("会话已移到系统回收站") } });
		expect(await fs.readFile(orphan, "utf8")).toBe("RETAIN"); expect(state.moved.map((entry) => entry.original)).toEqual([sessionA]);
	});

	it("reports a saved deletion if archive bookkeeping cannot be updated", async () => {
		await fs.writeFile(sessionA, header() + message("archive update failure"));
		const workspace = await import("../../src/lib/workspace-store");
		vi.spyOn(workspace, "forgetSession").mockRejectedValueOnce(new Error("registry unavailable"));
		const response = await remove(sessionA);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ success: true, data: { warningCode: "SESSION_DELETE_PARTIAL", warning: expect.stringContaining("列表状态") } });
	});

	it("does not call the recycler for a missing pending file", async () => {
		expect((await remove(sessionA)).status).toBe(200); expect(state.moved).toEqual([]);
	});
});
