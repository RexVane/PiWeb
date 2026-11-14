import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/remote/route";
import { ensureRemoteAccess, refreshPublicStatus, remoteStatus, resetRemoteSupervisor, startLan, startPublic, stopAll } from "@/lib/remote/supervisor";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), probe: vi.fn() }));
vi.mock("node:child_process", async (original) => ({ ...(await original<typeof import("node:child_process")>()), spawn: mocks.spawn }));
vi.mock("@/lib/remote/tunnel-health", () => ({ probeTunnel: mocks.probe }));
// Native promise timers retain their real clock on Windows; route this boundary through Vitest's fake clock.
vi.mock("node:timers/promises", () => ({
	setTimeout: (ms: number, value?: unknown, options?: { signal?: AbortSignal }) => new Promise((resolve, reject) => {
		const signal = options?.signal;
		const abort = () => { clearTimeout(timer); reject(Object.assign(new Error("aborted"), { name: "AbortError" })); };
		const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(value); }, ms);
		if (signal?.aborted) abort();
		else signal?.addEventListener("abort", abort, { once: true });
	}),
}));

function fakeChild() {
	const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: null as number | null, killed: false, kill: vi.fn() });
	child.kill.mockImplementation(() => { child.killed = true; child.exitCode = 0; child.emit("exit", 0); return true; });
	return child;
}
let children: ReturnType<typeof fakeChild>[];

beforeEach(() => {
	vi.useFakeTimers();
	resetRemoteSupervisor();
	children = [];
	vi.stubEnv("PI_WEB_AUTH", "1");
	vi.stubEnv("NODE_ENV", "test");
	vi.stubEnv("PIWEB_REMOTE_LAN", "1");
	vi.stubEnv("PI_WEB_TRUSTED_HOSTS", "");
	vi.stubEnv("PI_CODING_AGENT_DIR", path.join(os.tmpdir(), `piweb-remote-readonly-fixture-${randomUUID()}`));
	mocks.spawn.mockReset().mockImplementation(() => { const child = fakeChild(); children.push(child); return child; });
	mocks.probe.mockReset().mockResolvedValue({ ready: true, error: null });
});
afterEach(async () => { await stopAll(); resetRemoteSupervisor(); vi.useRealTimers(); vi.unstubAllEnvs(); });

async function loopbackFixture() {
	const socket = net.createServer();
	await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
	const port = (socket.address() as net.AddressInfo).port;
	await new Promise<void>((resolve) => socket.close(() => resolve()));
	// The automatic supervisor reuses this test listener; no application or public tunnel is exposed.
	await startLan(port, "127.0.0.1", 1);
}

async function publishAddress(url = "https://automatic-fixture.trycloudflare.com") {
	const starting = startPublic();
	children.at(-1)!.stdout.emit("data", Buffer.from(`${url}\n`));
	children.at(-1)!.stderr.emit("data", Buffer.from("Registered tunnel connection\n"));
	await vi.advanceTimersByTimeAsync(15_000);
	return starting;
}

describe("automatic remote connections", () => {
	it("returns a usable LAN entry immediately while sharing one pending public connection", async () => {
		await loopbackFixture();
		const [first, second] = await Promise.all([ensureRemoteAccess(), ensureRemoteAccess()]);
		expect(first.lan.running).toBe(true);
		expect(second.public).toMatchObject({ running: true, ready: false });
		expect(mocks.spawn).toHaveBeenCalledTimes(1);
		expect(await publishAddress()).toMatchObject({ ready: true });
		expect(process.env.PI_WEB_TRUSTED_HOSTS).toContain("automatic-fixture.trycloudflare.com");
	});

	it("waits for registration and DNS propagation before any status check can resolve the new domain", async () => {
		await loopbackFixture();
		await ensureRemoteAccess();
		const starting = startPublic();
		children[0].stdout.emit("data", Buffer.from("https://pending-fixture.trycloudflare.com\n"));
		await refreshPublicStatus(true);
		expect(mocks.probe).not.toHaveBeenCalled();
		children[0].stderr.emit("data", Buffer.from("Registered tunnel connection\n"));
		await vi.advanceTimersByTimeAsync(14_999);
		await refreshPublicStatus(true);
		expect(mocks.probe).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(await starting).toMatchObject({ ready: true });
		expect(mocks.probe).toHaveBeenCalledTimes(1);
	});

	it("reconnects after the tunnel exits and stops retrying when the service is stopped", async () => {
		await loopbackFixture();
		vi.useFakeTimers();
		await ensureRemoteAccess();
		await publishAddress();
		children[0].exitCode = 7;
		children[0].emit("exit", 7);
		expect(remoteStatus().public.running).toBe(false);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(mocks.spawn).toHaveBeenCalledTimes(2);
		await stopAll();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(mocks.spawn).toHaveBeenCalledTimes(2);
		expect(remoteStatus().lan.running).toBe(false);
	});

	it("checks again after a missing tunnel engine becomes available", async () => {
		await loopbackFixture();
		vi.useFakeTimers();
		await ensureRemoteAccess();
		const starting = startPublic();
		children[0].emit("error", Object.assign(new Error("fixture engine missing"), { code: "ENOENT" }));
		await starting;
		expect(remoteStatus().public.engineAvailable).toBe(false);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(mocks.spawn).toHaveBeenCalledTimes(2);
		expect(await publishAddress()).toMatchObject({ ready: true, engineAvailable: true });
	});

	it("replaces a live tunnel that stays unreachable, then publishes only the new working address", async () => {
		await loopbackFixture();
		vi.useFakeTimers();
		await ensureRemoteAccess();
		await publishAddress();
		mocks.probe.mockResolvedValue({ ready: false, error: "fixture connection unavailable" });
		await refreshPublicStatus(true);
		await vi.advanceTimersByTimeAsync(90_000);
		expect(remoteStatus().public).toMatchObject({ running: true, ready: false });
		expect(children[0].kill).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(30_000);
		await refreshPublicStatus(true);
		expect(remoteStatus().public).toMatchObject({ running: false, ready: false, url: null });
		expect(children[0].kill).toHaveBeenCalledTimes(1);
		expect(process.env.PI_WEB_TRUSTED_HOSTS).not.toContain("automatic-fixture.trycloudflare.com");
		mocks.probe.mockResolvedValue({ ready: true, error: null });
		await vi.advanceTimersByTimeAsync(60_000);
		expect(mocks.spawn).toHaveBeenCalledTimes(2);
		expect(await publishAddress("https://recovered-fixture.trycloudflare.com")).toMatchObject({
			ready: true, url: "https://recovered-fixture.trycloudflare.com", error: null,
		});
	});

	it("keeps the address after a brief outage and resets the stalled-connection timer", async () => {
		await loopbackFixture();
		vi.useFakeTimers();
		await ensureRemoteAccess();
		await publishAddress();
		mocks.probe.mockResolvedValue({ ready: false, error: "fixture connection unavailable" });
		await refreshPublicStatus(true);
		await vi.advanceTimersByTimeAsync(90_000);
		mocks.probe.mockResolvedValue({ ready: true, error: null });
		await refreshPublicStatus(true);
		mocks.probe.mockResolvedValue({ ready: false, error: "another short interruption" });
		await refreshPublicStatus(true);
		await vi.advanceTimersByTimeAsync(90_000);
		expect(mocks.spawn).toHaveBeenCalledTimes(1);
		expect(children[0].kill).not.toHaveBeenCalled();
		expect(remoteStatus().public).toMatchObject({ running: true, url: "https://automatic-fixture.trycloudflare.com" });
	});

	it("keeps automatic startup behind authentication, development and explicit listener restrictions", async () => {
		vi.stubEnv("PI_WEB_AUTH", "0");
		await ensureRemoteAccess();
		vi.stubEnv("PI_WEB_AUTH", "1");
		vi.stubEnv("NODE_ENV", "development");
		await ensureRemoteAccess();
		vi.stubEnv("NODE_ENV", "production");
		vi.stubEnv("PIWEB_REMOTE_LAN", "0");
		await ensureRemoteAccess();
		expect(remoteStatus().lan.running).toBe(false);
		expect(mocks.spawn).not.toHaveBeenCalled();
	});

	it("the unified connect API returns without waiting for public DNS readiness", async () => {
		await loopbackFixture();
		const response = await POST(new Request("http://localhost/api/remote", { method: "POST", body: JSON.stringify({ action: "connect" }) }));
		expect(response.status).toBe(200);
		const data = (await response.json()).data;
		expect(data.lan.running).toBe(true);
		expect(data.public.ready).toBe(false);
		expect(data).not.toHaveProperty("loginToken");
	});
});
