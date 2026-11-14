import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ sessions: [] as Array<{ path: string; cwd: string }>, warm: vi.fn(), after: [] as Array<() => unknown> }));
vi.mock("next/server", async (original) => ({ ...(await original<typeof import("next/server")>()), after: (callback: () => unknown) => { state.after.push(callback); } }));
vi.mock("@/lib/session-reader", () => ({ listSessions: async () => state.sessions }));
vi.mock("@/lib/agent-manager", () => ({ activeStatus: () => ({}), warmSessionResources: state.warm }));
import { GET } from "../../src/app/api/sessions/route";
import { addWorkspace, removeWorkspace, setAlias } from "../../src/lib/workspace-store";

describe("session workspace identity", () => {
	let root: string;
	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-session-workspaces-"));
		vi.stubEnv("PI_CODING_AGENT_DIR", root);
		state.sessions = [];
		state.warm.mockClear();
		state.after = [];
	});
	afterEach(async () => {
		vi.unstubAllEnvs();
		await fs.rm(root, { recursive: true, force: true });
	});

	it("groups historical CLI symlink sessions with the canonical workspace and its alias", async () => {
		const real = path.join(root, "real");
		const link = path.join(root, "cli-link");
		await fs.mkdir(real);
		await fs.symlink(real, link, process.platform === "win32" ? "junction" : "dir");
		const canonical = await fs.realpath(real);
		const key = process.platform === "win32" ? canonical.toLowerCase() : canonical;
		await addWorkspace(real);
		await setAlias(real, "My project");
		state.sessions = [{ path: "cli.jsonl", cwd: link }, { path: "web.jsonl", cwd: real }];
		const request = () => GET(new Request("http://localhost/api/sessions"));
		const first = await request();
		const body = await first.json();
		expect(body.data.sessions).toEqual([{ path: "cli.jsonl", cwd: canonical }, { path: "web.jsonl", cwd: canonical }]);
		expect(body.data.workspaceRegistry).toMatchObject({ workspaces: [canonical], aliases: { [key]: "My project" } });
		expect(state.warm).not.toHaveBeenCalled();
		expect(state.after).toHaveLength(1);
		await state.after.shift()!();
		expect(state.warm).toHaveBeenLastCalledWith([canonical]);
		const cached = await GET(new Request("http://localhost/api/sessions", { headers: { "if-none-match": first.headers.get("etag")! } }));
		expect(cached.status).toBe(304);
		await removeWorkspace(link);
		const removed = await (await request()).json();
		expect(removed.data.workspaceRegistry).toMatchObject({ workspaces: [], aliases: {}, removedWorkspaces: [canonical] });
		// Neither canonicalization nor polling may alter the original session headers.
		expect(state.sessions[0].cwd).toBe(link);
	});

	it("keeps a missing historical cwd and an empty cwd readable", async () => {
		const missing = path.join(root, "offline-workspace");
		state.sessions = [{ path: "old.jsonl", cwd: missing }, { path: "no-cwd.jsonl", cwd: "" }];
		const body = await (await GET(new Request("http://localhost/api/sessions"))).json();
		expect(body.data.sessions).toEqual(state.sessions);
		expect(body.data.workspaceRegistry.workspaces).toEqual([missing]);
	});
	it("serves discovered workspaces without writing on GET and paginates archived search results", async () => {
		state.sessions = [{ path: "a.jsonl", cwd: "one" }, { path: "b.jsonl", cwd: "two" }, { path: "c.jsonl", cwd: "three" }];
		const registry = path.join(root, "web-workspaces.json");
		await fs.writeFile(registry, JSON.stringify({ workspaces: [], archivedSessions: ["b.jsonl"] }));
		const before = await fs.readFile(registry, "utf8");
		const response = await GET(new Request("http://localhost/api/sessions?limit=1&offset=1&archived=exclude"));
		const body = await response.json();
		expect(body.data.sessions).toEqual([{ path: "c.jsonl", cwd: path.resolve("three") }]);
		expect(body.data).toMatchObject({ total: 2, nextOffset: null });
		expect(await fs.readFile(registry, "utf8")).toBe(before);
		expect((await GET(new Request("http://localhost/api/sessions?limit=0"))).status).toBe(400);
	});
	it("keeps the sidebar available and exposes a damaged registry without overwriting it", async () => {
		state.sessions = [{ path: "a.jsonl", cwd: "known" }];
		const registry = path.join(root, "web-workspaces.json"); await fs.writeFile(registry, "{broken");
		const response = await GET(new Request("http://localhost/api/sessions"));
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.data.workspaceRegistry.error).toContain("原文件已保留");
		expect(body.data.sessions).toHaveLength(1);
		expect(await fs.readFile(registry, "utf8")).toBe("{broken");
	});
});
