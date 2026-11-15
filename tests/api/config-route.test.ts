import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const agentDir = vi.hoisted(() => ({ value: "" }));
vi.mock("@/lib/pi", () => ({ getAgentDir: () => agentDir.value }));

import { GET } from "@/app/api/config/route";

const SETTINGS = {
	httpProxy: "http://proxy-user:proxy-password@127.0.0.1:7890",
	apiKey: "sk-live-AbCdEfGhIjKlMnOp",
	trackingId: "track-123456",
	compaction: { enabled: true, reserveTokens: 16384 },
	retry: { enabled: true, maxRetries: 3 },
	plain: "普通内容",
};
let original = "";
const roots: string[] = [];

beforeEach(async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-config-route-"));
	roots.push(root);
	agentDir.value = root;
	original = JSON.stringify(SETTINGS, null, 2);
	await fs.writeFile(path.join(root, "settings.json"), original);
});

afterEach(async () => {
	agentDir.value = "";
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

it("redacts credentials and telemetry ids from the downloaded settings by default", async () => {
	const response = await GET(new Request("http://127.0.0.1:30141/api/config"));
	expect(response.status).toBe(200);
	expect(response.headers.get("X-PiWeb-Redacted")).toBe("1");
	expect(response.headers.get("Content-Disposition")).toContain("attachment");
	const text = await response.text();
	expect(text).not.toContain("proxy-password");
	expect(text).not.toContain("sk-live-AbCdEfGhIjKlMnOp");
	expect(text).not.toContain("track-123456");
	// 普通设置与普通内容原样保留，且仍是合法 JSON
	const parsed = JSON.parse(text) as Record<string, any>;
	expect(parsed.plain).toBe("普通内容");
	expect(parsed.compaction).toEqual(SETTINGS.compaction);
	expect(parsed.retry.maxRetries).toBe(3);
	expect(parsed.httpProxy).toBe("http://proxy-user:***@127.0.0.1:7890");
	expect(parsed.apiKey).toBe("***");
	expect(parsed.trackingId).toBe("***");
});

it("returns the untouched file when raw=1 is explicitly requested", async () => {
	const response = await GET(new Request("http://127.0.0.1:30141/api/config?raw=1"));
	expect(response.status).toBe(200);
	expect(response.headers.get("X-PiWeb-Redacted")).toBeNull();
	expect(await response.text()).toBe(original);
});

it("accepts raw=true as the explicit opt-in too", async () => {
	const response = await GET(new Request("http://127.0.0.1:30141/api/config?raw=true"));
	expect(await response.text()).toBe(original);
});

it("reports an unreadable settings file as a structured 500", async () => {
	await fs.rm(path.join(agentDir.value, "settings.json"));
	const response = await GET(new Request("http://127.0.0.1:30141/api/config"));
	expect(response.status).toBe(500);
	expect(response.headers.get("Cache-Control")).toBe("no-store");
	expect(await response.json()).toMatchObject({ success: false });
});
