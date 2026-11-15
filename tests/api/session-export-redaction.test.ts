/**
 * 会话 JSONL 默认导出脱敏（I1）：会话里可能留着用户贴过的 key / token / 代理口令。
 * 直接跑真实 exportSession 的 jsonl 分支（只读文件，不冷启动 SDK）。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/growth-tracker", () => ({
	GROWTH_TRACKER_VERSION: 1,
	createGrowthTracker: () => ({ version: 1, prepare: async () => {}, onEvent: () => {}, dispose: () => {} }),
}));

import { exportSession } from "@/lib/agent-manager";

type Managed = Parameters<typeof exportSession>[0];

const SECRET_LINE = JSON.stringify({ type: "message", message: { role: "assistant", apiKey: "sk-live-AbCdEfGhIjKlMn", note: "普通内容" } });
const PROXY_LINE = JSON.stringify({ type: "tool", output: "proxy http://tool-user:proxy-pass@127.0.0.1:7890 ready" });
const BEARER_LINE = JSON.stringify({ type: "message", output: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345" });
const PLAIN_LINE = JSON.stringify({ type: "message", message: { role: "user", content: "你好，普通内容 tokenCount=5" } });

let root = "";
let sessionPath = "";
let original = "";

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-export-redaction-"));
	sessionPath = path.join(root, "fixed-name.jsonl");
	original = [SECRET_LINE, PROXY_LINE, BEARER_LINE, PLAIN_LINE].join("\n") + "\n";
	await fs.writeFile(sessionPath, original);
});

afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

function managed(): Managed {
	return { sessionPath, cwd: root, session: null, creating: null, disposed: false, seq: 0, buffer: [], subscribers: new Set() } as unknown as Managed;
}

describe("exportSession jsonl redaction", () => {
	it("redacts credentials by default and keeps ordinary conversation content", async () => {
		const result = await exportSession(managed(), "jsonl");
		expect(result.filename).toBe("fixed-name.jsonl");
		expect(result.contentType).toBe("application/jsonl");
		expect(result.content).not.toContain("sk-live-AbCdEfGhIjKlMn");
		expect(result.content).not.toContain("proxy-pass");
		expect(result.content).not.toContain("abcdefghijklmnopqrstuvwxyz012345");
		expect(result.content).toContain("普通内容");
		const lines = result.content.split("\n");
		expect(lines).toHaveLength(5);
		for (const line of lines.slice(0, 4)) expect(() => JSON.parse(line)).not.toThrow();
		const assistant = JSON.parse(lines[0]) as { message: Record<string, unknown> };
		expect(assistant.message.apiKey).toBe("***");
		expect(assistant.message.note).toBe("普通内容");
		expect(JSON.parse(lines[1]).output).toBe("proxy http://tool-user:***@127.0.0.1:7890 ready");
		expect(JSON.parse(lines[2]).output).toBe("Authorization: Bearer ***");
		expect(lines[3]).toBe(PLAIN_LINE);
	});

	it("returns the untouched file when raw is explicitly requested", async () => {
		const result = await exportSession(managed(), "jsonl", { raw: true });
		expect(result.content).toBe(original);
	});
});
