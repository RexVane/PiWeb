import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recycleFixture } from "../lib/sandbox/fixtures";

const state = vi.hoisted(() => ({ sessions: [] as Array<{ path: string; cwd: string }>, warm: vi.fn(), after: [] as Array<() => unknown> }));
vi.mock("next/server", async (original) => ({ ...(await original<typeof import("next/server")>()), after: (callback: () => unknown) => { state.after.push(callback); } }));
vi.mock("@/lib/session-reader", () => ({ listSessions: async () => state.sessions }));
vi.mock("@/lib/agent-manager", () => ({ activeStatus: () => ({}), warmSessionResources: state.warm }));
import { GET } from "../../src/app/api/sessions/route";
import { addWorkspace, removeWorkspace, setAlias } from "../../src/lib/workspace-store";

describe("session workspace identity", () => {
	let root: string;
	beforeEach(async () => {
		root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "piweb-session-workspaces-")));
		vi.stubEnv("PI_CODING_AGENT_DIR", root);
		state.sessions = [];
		state.warm.mockClear();
		state.after = [];
	});
	afterEach(async () => {
		vi.unstubAllEnvs();
		await recycleFixture(root);
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
	it("preserves the ETag when archive stat queries complete in a different order", async () => {
		const archivedSessions = [path.join(root, "first.jsonl"), path.join(root, "second.jsonl")];
		const keyOf = (file: string) => process.platform === "win32" ? file.toLowerCase() : file;
		const archivedAt = 1_700_000_000_000;
		const modifiedAt = archivedAt + 1_000;
		const registry = path.join(root, "web-workspaces.json");
		const original = JSON.stringify({
			workspaces: [],
			archivedSessions,
			archivedAt: Object.fromEntries(archivedSessions.map((file) => [keyOf(file), archivedAt])),
		});
		await fs.writeFile(registry, original);

		const pending = new Map<string, () => void>();
		const stat = fs.stat.bind(fs);
		const mock = vi.spyOn(fs, "stat").mockImplementation((...args: Parameters<typeof fs.stat>) => {
			const file = String(args[0]);
			if (!archivedSessions.includes(file)) return stat(...args);
			return new Promise<Awaited<ReturnType<typeof fs.stat>>>((resolve) => {
				pending.set(file, () => resolve({
					isFile: () => true, mtimeMs: modifiedAt,
				} as Awaited<ReturnType<typeof fs.stat>>));
			});
		});

		async function request(order: string[], etag?: string) {
			const response = GET(new Request("http://localhost/api/sessions", {
				headers: etag ? { "if-none-match": etag } : undefined,
			}));
			await vi.waitFor(() => expect(pending.size).toBe(2));
			for (const file of order) {
				pending.get(file)!();
				pending.delete(file);
				await Promise.resolve();
			}
			return response;
		}

		try {
			const first = await request(archivedSessions);
			expect(first.status).toBe(200);
			const cached = await request([...archivedSessions].reverse(), first.headers.get("etag")!);
			expect(cached.status).toBe(304);
			expect(cached.headers.get("etag")).toBe(first.headers.get("etag"));
			expect(await fs.readFile(registry, "utf8")).toBe(original);
		} finally {
			mock.mockRestore();
		}
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
	it("orders archived=only results by archivedAt descending instead of file modified time", async () => {
		const newerArchive = path.join(root, "newer-archive.jsonl");
		const olderArchive = path.join(root, "older-archive.jsonl");
		const keyOf = (file: string) => process.platform === "win32" ? file.toLowerCase() : file;
		const now = Date.now();
		const DAY = 24 * 60 * 60 * 1000;
		await fs.writeFile(newerArchive, "");
		await fs.writeFile(olderArchive, "");
		// Match the real-world bug: newerArchive has an older file mtime (10d ago) than olderArchive (5d ago),
		// so listSessions() returns olderArchive first, yet newerArchive was archived more recently (2d ago vs 5d ago).
		await fs.utimes(newerArchive, new Date(now - 10 * DAY), new Date(now - 10 * DAY));
		await fs.utimes(olderArchive, new Date(now - 5 * DAY), new Date(now - 5 * DAY));
		state.sessions = [
			{ path: olderArchive, cwd: root },
			{ path: newerArchive, cwd: root },
		];
		await fs.writeFile(path.join(root, "web-workspaces.json"), JSON.stringify({
			workspaces: [],
			archivedSessions: [olderArchive, newerArchive],
			archivedAt: {
				[keyOf(olderArchive)]: now - 5 * DAY,
				[keyOf(newerArchive)]: now - 2 * DAY,
			},
		}));
		const response = await GET(new Request("http://localhost/api/sessions?archived=only"));
		const body = await response.json();
		expect(body.data.sessions.map((s: { path: string }) => s.path)).toEqual([newerArchive, olderArchive]);
	});
});
