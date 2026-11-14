import net from "node:net";
import http from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { startLan, stopLan, stopAll, remoteStatus, resetRemoteSupervisor } from "../src/lib/remote/supervisor";
afterEach(async () => { await stopAll(); resetRemoteSupervisor(); vi.restoreAllMocks(); });
async function freePort() { const srv = net.createServer(); await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve)); const port = (srv.address() as net.AddressInfo).port; await new Promise<void>((resolve) => srv.close(() => resolve())); return port; }
it("does not reopen a pending LAN listener after stop resolves", async () => {
	const port = await freePort();
	const starting = startLan(port, "127.0.0.1", 1);
	const stopping = stopLan();
	await Promise.all([starting, stopping]);
	expect(remoteStatus().lan.running).toBe(false);
	const probe = net.createServer(); await new Promise<void>((resolve, reject) => { probe.once("error", reject); probe.listen(port, "127.0.0.1", resolve); });
	await new Promise<void>((resolve) => probe.close(() => resolve()));
});
it("removes successful listen's temporary error handler and exposes subsequent listener errors", async () => {
	const port = await freePort(); let created: http.Server | undefined;
	const create = http.createServer;
	vi.spyOn(http, "createServer").mockImplementation(((...args: Parameters<typeof http.createServer>) => { created = create(...args); return created; }) as typeof http.createServer);
	await startLan(port, "127.0.0.1", 1);
	expect(created!.listenerCount("error")).toBe(1);
	created!.emit("error", new Error("fixture listener failed"));
	expect(remoteStatus().lan).toMatchObject({ running: false, error: "fixture listener failed" });
});
