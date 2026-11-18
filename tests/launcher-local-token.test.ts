import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { randomBytes } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { readCurrentLaunchToken } from "../scripts/launcher.mjs";
import { launchTokenIpcPath, launchIpcProof, validLaunchIpcProof } from "../scripts/web-auth-protocol.mjs";
import { recycleFixture } from "./fixtures/recycle";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture(handler?: (request: Record<string, string>, socket: net.Socket, file: string) => void | Promise<void>) {
	const agentRoot = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-local-token-"));
	cleanups.push(() => recycleFixture(agentRoot));
	await fs.mkdir(path.join(agentRoot, "web-launch"));
	const file = path.join(agentRoot, "web-launch", "30141.token");
	await fs.writeFile(file, "old_abcdefghijklmnop\n");
	if (handler) {
		const server = net.createServer((socket) => {
			let input = "";
			socket.on("data", (chunk) => {
				input += chunk.toString();
				while (input.includes("\n")) { const boundary = input.indexOf("\n"); const message = input.slice(0, boundary); input = input.slice(boundary + 1); void handler(JSON.parse(message), socket, file); }
			});
		});
		await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(launchTokenIpcPath(agentRoot, "30141"), resolve); });
		cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
	}
	return { env: { PI_CODING_AGENT_DIR: agentRoot }, file };
}
function authenticatedHandler(afterAuth?: (file: string) => Promise<void>) {
	const handshakes = new WeakMap<net.Socket, { token: string; clientNonce: string; serverNonce: string }>();
	return async (request: Record<string, string>, socket: net.Socket, file: string) => {
		const state = handshakes.get(socket);
		if (!state) {
			expect(request).not.toHaveProperty("token");
			const next = { token: (await fs.readFile(file, "utf8")).trim(), clientNonce: request.clientNonce, serverNonce: randomBytes(32).toString("base64url") };
			handshakes.set(socket, next);
			socket.write(JSON.stringify({ serverNonce: next.serverNonce, proof: launchIpcProof(next.token, "server", next.clientNonce, next.serverNonce) }) + "\n");
		} else {
			expect(validLaunchIpcProof(request.proof, state.token, "client", state.clientNonce, state.serverNonce)).toBe(true);
			await afterAuth?.(file);
			socket.end(JSON.stringify({ proof: launchIpcProof(state.token, "ready", state.clientNonce, state.serverNonce) }) + "\n");
		}
	};
}
it("opens the renewed file value after authenticating the private local service", async () => {
	const f = await fixture(authenticatedHandler((file) => fs.writeFile(file, "new_abcdefghijklmnop\n")));
	expect(await readCurrentLaunchToken(30141, f.env)).toBe("new_abcdefghijklmnop");
});
it("rereads a token rotated between the file read and IPC verification", async () => {
	let calls = 0;
	const handler = authenticatedHandler();
	const f = await fixture(async (request, socket, file) => {
		if (request.clientNonce) calls += 1;
		if (calls === 1) { await fs.writeFile(file, "new_abcdefghijklmnop\n"); socket.end('{"error":"invalid_token"}\n'); return; }
		await handler(request, socket, file);
	});
	expect(await readCurrentLaunchToken(30141, f.env)).toBe("new_abcdefghijklmnop");
	expect(calls).toBe(2);
});
it("does not use an unverified stale token when the local endpoint is unavailable", async () => {
	const f = await fixture();
	expect(await readCurrentLaunchToken(30141, f.env)).toBeNull();
});
it("bounds replies and rejects malformed or unavailable credentials", async () => {
	const f = await fixture((_request, socket) => { socket.end("x".repeat(1025)); });
	expect(await readCurrentLaunchToken(30141, f.env)).toBeNull();
});
it("finds the same private endpoint through a directory alias", async () => {
	const f = await fixture(authenticatedHandler());
	const alias = path.join(path.dirname(f.env.PI_CODING_AGENT_DIR), `${path.basename(f.env.PI_CODING_AGENT_DIR)}-alias`);
	await fs.symlink(f.env.PI_CODING_AGENT_DIR, alias, process.platform === "win32" ? "junction" : "dir");
	cleanups.push(() => fs.unlink(alias));
	expect(await readCurrentLaunchToken(30141, { PI_CODING_AGENT_DIR: alias })).toBe("old_abcdefghijklmnop");
	if (process.platform === "win32") expect(await readCurrentLaunchToken(30141, { PI_CODING_AGENT_DIR: f.env.PI_CODING_AGENT_DIR.toUpperCase() })).toBe("old_abcdefghijklmnop");
});
it("reveals no credential to a predictable pipe impersonator and rejects its forged reply", async () => {
	const seen: string[] = [];
	const f = await fixture((request, socket) => { seen.push(JSON.stringify(request)); socket.end(JSON.stringify({ token: "forged_abcdefghijklmnop" }) + "\n"); });
	expect(await readCurrentLaunchToken(30141, f.env)).toBeNull();
	expect(seen).toHaveLength(2);
	expect(seen.join("")).not.toContain("old_abcdefghijklmnop");
	expect(JSON.parse(seen[0])).toEqual({ clientNonce: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });
});
