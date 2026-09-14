import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { PHASE_PRODUCTION_BUILD } from "next/constants";
import { getCloneableBody } from "next/dist/server/body-streams";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import nextConfig from "../next.config";
import { POST } from "../src/app/api/files/route";

let directory = "";
let previous: string | undefined;
beforeEach(async () => {
	previous = process.env.PI_CODING_AGENT_DIR;
	directory = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-proxy-upload-"));
	process.env.PI_CODING_AGENT_DIR = directory;
});
afterEach(async () => {
	if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previous;
	await fs.rm(directory, { recursive: true, force: true });
	vi.restoreAllMocks();
});

async function throughProxy(limit?: number) {
	const size = 11 * 1024 * 1024;
	const source = Buffer.alloc(size, 0x61);
	const chunks = Array.from({ length: 176 }, (_, i) => source.subarray(i * 65536, (i + 1) * 65536));
	const request = Readable.from(chunks) as IncomingMessage;
	request.url = "/api/files?action=upload&name=proxy.bin";
	const cloneable = getCloneableBody(request, limit);
	const proxy = cloneable.cloneBodyStream();
	for await (const _chunk of proxy) { /* Drain the middleware view before the route reads the clone. */ }
	await cloneable.finalize();
	const response = await POST(new Request("http://localhost/api/files?action=upload&name=proxy.bin", {
		method: "POST",
		headers: { "Content-Type": "application/octet-stream", "content-length": String(size), "x-upload-size": String(size) },
		body: Readable.toWeb(request) as ReadableStream<Uint8Array>,
		duplex: "half",
	} as RequestInit));
	return { response, source };
}

it("preserves an 11 MiB upload through Next's configured body cloning layer", async () => {
	const configured = nextConfig(PHASE_PRODUCTION_BUILD).experimental?.proxyClientMaxBodySize;
	const limit = typeof configured === "number" ? configured : Number.parseInt(String(configured), 10) * 1024 * 1024;
	expect(limit).toBeGreaterThanOrEqual(268_000_000 + 1_000_000);
	const { response, source } = await throughProxy(limit);
	expect(response.status).toBe(200);
	const result = await response.json();
	expect(result).toMatchObject({ success: true, data: { size: source.length } });
	expect((await fs.readFile(result.data.path)).equals(source)).toBe(true);
}, 20_000);

it("fails closed when an upstream proxy truncates an upload", async () => {
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
	const { response } = await throughProxy(10 * 1024 * 1024);
	expect(response.status).toBe(400);
	expect(await response.json()).toMatchObject({ success: false, error: expect.stringContaining("incomplete upload") });
	expect(await fs.readdir(path.join(directory, "web-uploads"))).toEqual([]);
}, 20_000);
