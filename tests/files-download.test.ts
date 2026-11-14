import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GET, HEAD } from "@/app/api/files/download/route";
import * as filesService from "@/lib/files-service";
import { createSessionCookie, sessionCookieId, SESSION_MAX_AGE_SECONDS } from "@/lib/web-auth";
import { recycleFixture } from "./lib/sandbox/fixtures";

const credentials = vi.hoisted(() => ({ secret: Buffer.alloc(32, 7), revocations: { notBefore: 0, revoked: new Map<string, number>(), unavailable: false } }));
vi.mock("@/lib/web-secret", () => ({ loadWebSecret: () => credentials.secret, loadSessionRevocations: () => credentials.revocations }));
let base: string, root: string;
beforeEach(async () => {
	base = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-download-")); root = path.join(base, "workspace"); await fs.mkdir(root);
	credentials.revocations = { notBefore: 0, revoked: new Map(), unavailable: false };
	vi.stubEnv("PI_WEB_AUTH", "1");
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); await recycleFixture(base); });
function cookie(authority = "localhost", issued = Date.now()) {
	const value = createSessionCookie(authority, credentials.secret, issued); return `${value.name}=${value.value}`;
}
function request(file = "large.txt", headers: Record<string, string> = {}, options: RequestInit = {}) {
	return new Request(`http://localhost/api/files/download?${new URLSearchParams({ cwd: root, path: file })}`, { ...options, headers: { cookie: cookie(), ...headers } });
}
async function trackOpen() {
	const original = fs.open; const closes: ReturnType<typeof vi.spyOn>[] = [];
	vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
		const handle = await original(...args); closes.push(vi.spyOn(handle, "close")); return handle;
	});
	return closes;
}
it("streams the complete authenticated file beyond preview limits using at most 64 KiB chunks", async () => {
	const content = Buffer.alloc(1024 * 1024 + 123); for (let index = 0; index < content.length; index++) content[index] = index % 251;
	await fs.writeFile(path.join(root, "large.txt"), content); const closes = await trackOpen();
	const response = await GET(request()); expect(response.status).toBe(200);
	expect(response.headers.get("cache-control")).toBe("private, no-store"); expect(response.headers.get("content-length")).toBe(String(content.length));
	expect(response.headers.get("content-disposition")).toContain("attachment;");
	const reader = response.body!.getReader(); const chunks: Uint8Array[] = [];
	while (true) { const item = await reader.read(); if (item.done) break; expect(item.value.length).toBeLessThanOrEqual(64 * 1024); chunks.push(item.value); }
	expect(Buffer.concat(chunks)).toEqual(content); expect(closes[0]).toHaveBeenCalledTimes(1);
});
it("enforces host, same-origin, cookie authority, expiration, revocation and unavailable revocation state", async () => {
	await fs.writeFile(path.join(root, "large.txt"), "secret"); const open = vi.spyOn(fs, "open");
	for (const headers of [{ cookie: "" }, { cookie: "invalid" }, { cookie: cookie("127.0.0.1") }, { cookie: cookie("localhost", Date.now() - (SESSION_MAX_AGE_SECONDS + 1) * 1000) }]) {
		expect((await GET(request("large.txt", headers))).status).toBe(401);
	}
	expect((await GET(request("large.txt", { host: "attacker.example" }))).status).toBe(403);
	expect((await GET(request("large.txt", { origin: "http://attacker.example" }))).status).toBe(403);
	expect((await GET(request("large.txt", { "sec-fetch-site": "cross-site" }))).status).toBe(403);
	const value = createSessionCookie("localhost", credentials.secret); credentials.revocations.revoked.set(sessionCookieId(value.value)!, Date.now());
	expect((await GET(request("large.txt", { cookie: `${value.name}=${value.value}` }))).status).toBe(401);
	credentials.revocations.unavailable = true; expect((await GET(request())).status).toBe(503); expect(open).not.toHaveBeenCalled();
});
it("serves byte/suffix ranges, rejects invalid ranges, and closes empty/HEAD handles", async () => {
	await fs.writeFile(path.join(root, "large.txt"), "0123456789"); await fs.writeFile(path.join(root, "empty.txt"), ""); const closes = await trackOpen();
	for (const [range, expected, contentRange] of [["bytes=2-5", "2345", "bytes 2-5/10"], ["bytes=-3", "789", "bytes 7-9/10"], ["bytes=8-99", "89", "bytes 8-9/10"]]) {
		const response = await GET(request("large.txt", { range })); expect(response.status).toBe(206); expect(response.headers.get("content-range")).toBe(contentRange); expect(await response.text()).toBe(expected);
	}
	for (const range of ["bytes=10-", "bytes=5-2", "bytes=-0", "bytes=0-1,3-4", "bytes=9007199254740992-"]) {
		const response = await GET(request("large.txt", { range })); expect(response.status).toBe(416); expect(response.headers.get("content-range")).toBe("bytes */10");
	}
	const head = await HEAD(request("large.txt", {}, { method: "HEAD" })); expect(head.body).toBeNull(); expect(head.headers.get("content-length")).toBe("10");
	const empty = await GET(request("empty.txt")); expect(empty.body).toBeNull(); expect(empty.headers.get("content-length")).toBe("0");
	expect(closes.every((close) => close.mock.calls.length === 1)).toBe(true);
});
it("rejects traversal and a real directory junction to a sibling outside the workspace", async () => {
	await fs.mkdir(path.join(base, "outside")); await fs.writeFile(path.join(base, "outside", "secret.txt"), "private");
	await fs.symlink(path.join(base, "outside"), path.join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
	expect((await GET(request("../outside/secret.txt"))).status).toBe(400);
	expect((await GET(request("escape/secret.txt"))).status).toBe(400);
	expect((await GET(request("missing.txt"))).status).toBe(400);
});
it("closes the pinned handle on reader cancellation or request abortion", async () => {
	await fs.writeFile(path.join(root, "large.txt"), Buffer.alloc(1024 * 1024)); const closes = await trackOpen();
	const first = await GET(request()); const reader = first.body!.getReader(); await reader.read(); await reader.cancel(); expect(closes[0]).toHaveBeenCalledTimes(1);
	const controller = new AbortController(); const second = await GET(request("large.txt", {}, { signal: controller.signal })); const secondReader = second.body!.getReader();
	await secondReader.read(); controller.abort(); await expect(secondReader.read()).rejects.toThrow("download canceled");
	await vi.waitFor(() => expect(closes[1]).toHaveBeenCalledTimes(1));
});
it("closes an opened handle if filename encoding fails before response ownership transfers", async () => {
	await fs.writeFile(path.join(root, "large.txt"), "x");
	const file = await filesService.openWorkspaceFile(root, "large.txt"); const close = vi.spyOn(file.handle, "close");
	vi.spyOn(filesService, "openWorkspaceFile").mockResolvedValue({ ...file, name: "\ud800.txt" });
	const response = await GET(request()); expect(response.status).toBe(500); expect(close).toHaveBeenCalledTimes(1);
	expect(JSON.stringify(await response.json())).not.toContain(root);
});
