import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ sessions: [] as Array<{ path: string; cwd: string }>, warm: vi.fn() }));
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
});
