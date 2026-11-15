import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * I3：删除会话时同步清理“只被这个会话引用”的上传附件。
 * 清理必须可恢复（recoverableRemove：先写副本 + INDEX，再移走原件），
 * 证据不足（其它会话读不全、会话目录异常）时一个附件都不许删。
 */
let tempDir = "";
let agentDir = "";
let uploads = "";
let sessionA = "";
let sessionB = "";
let DELETE: typeof import("../../src/app/api/sessions/[id]/route")["DELETE"];
let encodeSessionId: typeof import("../../src/lib/pi")["encodeSessionId"];
const previous = { agentDir: process.env.PI_CODING_AGENT_DIR };

const line = (entry: unknown) => `${JSON.stringify(entry)}\n`;

/** 会话内容里引用附件的写法与真实 JSONL 一致：绝对路径被 JSON 转义（Windows 是双反斜杠） */
function sessionLine(file: string, text: string) {
	return line({
		type: "message",
		id: "u1",
		parentId: null,
		timestamp: "2026-01-01T00:00:01.000Z",
		message: { role: "user", content: [{ type: "text", text }], timestamp: 1767225601000 },
	});
}

function sessionHeader() {
	return line({ type: "session", version: 3, id: "s", timestamp: "2026-01-01T00:00:00.000Z", cwd: "D:\\Proj" });
}

async function putUpload(name: string, body: string): Promise<string> {
	const file = path.join(uploads, name);
	await fs.writeFile(file, body);
	return file;
}

async function deleteSessionThroughRoute(file: string): Promise<Response> {
	const id = encodeSessionId(file);
	return DELETE(new Request(`http://127.0.0.1:30141/api/sessions/${id}`, { method: "DELETE" }), { params: Promise.resolve({ id }) });
}

beforeAll(async () => {
	tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "piweb-delete-attachments-")));
	agentDir = path.join(tempDir, "agent");
	uploads = path.join(agentDir, "web-uploads");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PI_OFFLINE = "1";
	process.env.PI_WEB_UPDATE_CHECK = "0";
	// 恢复副本必须落进临时 HOME，不能碰用户真实 ~/.agents/backups
	vi.spyOn(os, "homedir").mockReturnValue(tempDir);
	({ DELETE } = await import("../../src/app/api/sessions/[id]/route"));
	({ encodeSessionId } = await import("../../src/lib/pi"));
}, 120_000);

afterAll(async () => {
	vi.restoreAllMocks();
	if (previous.agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previous.agentDir;
	await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
});

beforeEach(async () => {
	await fs.rm(path.join(agentDir, "sessions"), { recursive: true, force: true });
	await fs.rm(uploads, { recursive: true, force: true });
	await fs.rm(path.join(tempDir, ".agents"), { recursive: true, force: true });
	await fs.mkdir(path.join(agentDir, "sessions", "workspace"), { recursive: true });
	await fs.mkdir(uploads, { recursive: true });
	sessionA = path.join(agentDir, "sessions", "workspace", "delete-me.jsonl");
	sessionB = path.join(agentDir, "sessions", "workspace", "keep-me.jsonl");
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("deleting a session cleans up its orphaned upload attachments (I3)", () => {
	it("removes attachments only referenced by the deleted session, keeping a recoverable copy", async () => {
		const shared = await putUpload("shared-report.txt", "SHARED-BODY");
		const orphan = await putUpload("orphan-only-here.txt", "ORPHAN-BODY");
		const unrelated = await putUpload("another-sessions-upload.txt", "UNRELATED-BODY");
		await fs.writeFile(sessionA, sessionHeader() + sessionLine(sessionA, `附件 ${orphan} 和 ${shared}`));
		await fs.writeFile(sessionB, sessionHeader() + sessionLine(sessionB, `继续用 ${shared}`));

		const response = await deleteSessionThroughRoute(sessionA);
		expect(response.status).toBe(200);
		expect(await fs.stat(sessionA).then(() => true, () => false)).toBe(false);
		// 只被删掉的会话引用的附件：移走（不是硬删）；仍被别的会话引用的、以及本该由 30 天 sweep 处理的，都不动
		expect(await fs.stat(orphan).then(() => true, () => false)).toBe(false);
		expect(await fs.readFile(shared, "utf8")).toBe("SHARED-BODY");
		expect(await fs.readFile(unrelated, "utf8")).toBe("UNRELATED-BODY");
		// 恢复语义：副本 + INDEX 都在临时 HOME 下
		const backups = path.join(tempDir, ".agents", "backups");
		const index = await fs.readFile(path.join(backups, "INDEX.md"), "utf8");
		const lineForOrphan = index.split("\n").find((entry) => entry.includes("orphan-only-here.txt"));
		expect(lineForOrphan).toBeTruthy();
		const backupPath = lineForOrphan!.split(" | ")[2];
		expect(await fs.readFile(backupPath, "utf8")).toBe("ORPHAN-BODY");
		expect(index).toContain("清理无会话引用的上传附件");
	});

	it("cleans a freshly uploaded attachment too (no 30-day grace for a deleted session's own references)", async () => {
		const fresh = await putUpload(`fresh-${Date.now()}.bin`, "FRESH");
		await fs.writeFile(sessionA, sessionHeader() + sessionLine(sessionA, `看图 ${fresh}`));
		expect((await deleteSessionThroughRoute(sessionA)).status).toBe(200);
		expect(await fs.stat(fresh).then(() => true, () => false)).toBe(false);
	});

	it("keeps attachments when the cleanup is disabled with PI_WEB_DELETE_ATTACHMENT_CLEANUP=0", async () => {
		const orphan = await putUpload("keep-because-disabled.txt", "KEEP");
		await fs.writeFile(sessionA, sessionHeader() + sessionLine(sessionA, `附件 ${orphan}`));
		vi.stubEnv("PI_WEB_DELETE_ATTACHMENT_CLEANUP", "0");
		expect((await deleteSessionThroughRoute(sessionA)).status).toBe(200);
		expect(await fs.readFile(orphan, "utf8")).toBe("KEEP");
	});

	it("keeps attachments when the other session references cannot be read completely", async () => {
		const orphan = await putUpload("must-not-be-deleted.txt", "SAFE");
		await fs.writeFile(sessionA, sessionHeader() + sessionLine(sessionA, `附件 ${orphan}`));
		// 一个叫 *.jsonl 的目录让“其它会话是否还引用它”无法证明：宁可不删
		await fs.mkdir(path.join(agentDir, "sessions", "workspace", "broken.jsonl"), { recursive: true });
		expect((await deleteSessionThroughRoute(sessionA)).status).toBe(200);
		expect(await fs.readFile(orphan, "utf8")).toBe("SAFE");
	});

	it("still deletes the session when there are no uploads at all", async () => {
		await fs.writeFile(sessionA, sessionHeader() + sessionLine(sessionA, "纯文本会话"));
		expect((await deleteSessionThroughRoute(sessionA)).status).toBe(200);
		expect(await fs.stat(sessionA).then(() => true, () => false)).toBe(false);
	});
});
