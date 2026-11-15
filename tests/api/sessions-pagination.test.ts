import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recycleFixture } from "../lib/sandbox/fixtures";

/**
 * D4（route 侧）：`/api/sessions` 的可选 `limit`/`offset` 透传给 `session-reader.listSessions`。
 * 归档视图（archived=only|exclude）必须先过滤再分页，仍由 route 自己切片；
 * 工作区发现、total、响应字节都与改动前一致（route 只用全量结果做发现，分页走 lib）。
 */
const state = vi.hoisted(() => ({
	sessions: [] as Array<{ path: string; cwd: string; modified?: string }>,
	calls: [] as Array<{ query?: string; options?: { limit?: number; offset?: number } }>,
	warm: vi.fn(),
	after: [] as Array<() => unknown>,
}));

vi.mock("next/server", async (original) => ({ ...(await original<typeof import("next/server")>()), after: (callback: () => unknown) => { state.after.push(callback); } }));
vi.mock("@/lib/session-reader", () => ({
	listSessions: async (query?: string, options?: { limit?: number; offset?: number }) => {
		state.calls.push({ query, options });
		const offset = options?.offset ?? 0;
		return options?.limit === undefined ? state.sessions : state.sessions.slice(offset, offset + options.limit);
	},
}));
vi.mock("@/lib/agent-manager", () => ({ activeStatus: () => ({}), warmSessionResources: state.warm }));

import { GET } from "../../src/app/api/sessions/route";

describe("sessions route pagination", () => {
	let root: string;
	beforeEach(async () => {
		root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "piweb-sessions-route-page-")));
		vi.stubEnv("PI_CODING_AGENT_DIR", root);
		state.sessions = ["a", "b", "c", "d"].map((name) => ({ path: path.join(root, `${name}.jsonl`), cwd: root, modified: name }));
		state.calls = [];
		state.warm.mockClear();
		state.after = [];
	});
	afterEach(async () => {
		vi.unstubAllEnvs();
		await recycleFixture(root);
	});

	it("keeps the default full response and calls listSessions without pagination", async () => {
		const response = await GET(new Request("http://localhost/api/sessions"));
		const body = await response.json();
		expect(response.status).toBe(200);
		expect(body.data.sessions).toHaveLength(4);
		expect(body.data.total).toBeUndefined();
		expect(body.data.nextOffset).toBeUndefined();
		expect(state.calls).toEqual([{ query: undefined, options: undefined }]);
	});

	it("passes limit/offset through to session-reader and reports total/nextOffset", async () => {
		const response = await GET(new Request("http://localhost/api/sessions?limit=2&offset=1"));
		const body = await response.json();
		expect(response.status).toBe(200);
		expect(body.data.sessions.map((session: { path: string }) => path.basename(session.path))).toEqual(["b.jsonl", "c.jsonl"]);
		// 第一次全量（工作区发现 + total 需要），第二次带分页参数（命中 lib 的列表缓存）
		expect(state.calls).toEqual([
			{ query: undefined, options: undefined },
			{ query: undefined, options: { limit: 2, offset: 1 } },
		]);
		expect(body.data).toMatchObject({ total: 4, nextOffset: 3 });
	});

	it("passes the search query together with pagination", async () => {
		await GET(new Request("http://localhost/api/sessions?q=abc&limit=1&offset=0"));
		expect(state.calls.at(-1)).toEqual({ query: "abc", options: { limit: 1, offset: 0 } });
	});

	it("keeps archive filtering before pagination instead of delegating it to the reader", async () => {
		const registry = path.join(root, "web-workspaces.json");
		await fs.writeFile(registry, JSON.stringify({ workspaces: [], archivedSessions: [state.sessions[0].path] }));
		const response = await GET(new Request("http://localhost/api/sessions?limit=1&offset=1&archived=exclude"));
		const body = await response.json();
		expect(response.status).toBe(200);
		// 过滤掉 a 后剩 b,c,d：偏移 1 → c
		expect(body.data.sessions.map((session: { path: string }) => path.basename(session.path))).toEqual(["c.jsonl"]);
		expect(body.data).toMatchObject({ total: 3, nextOffset: 2 });
		// 归档视图只在 route 里切片，不再向 lib 透传分页
		expect(state.calls).toEqual([{ query: undefined, options: undefined }]);
	});

	it("rejects invalid pagination values", async () => {
		for (const query of ["limit=0", "limit=501", "limit=abc", "limit=1.5", "offset=-1", "offset=abc"]) {
			const response = await GET(new Request(`http://localhost/api/sessions?${query}`));
			expect(response.status, query).toBe(400);
			expect(await response.json()).toMatchObject({ success: false, errorCode: "VALIDATION_ERROR" });
		}
	});
});
