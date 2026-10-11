import net from "node:net";
import type os from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { GET, POST } from "../src/app/api/remote/route";
import { allowTunnelHost, createUrlCatcher, disallowTunnelHost, lanAddresses, managedEnginePath, piwebPort, remoteBlocked, remoteLanEnabled, remoteLanPort, remoteStatus, resetRemoteSupervisor, startLan, stopAll, tunnelEngine } from "../src/lib/remote/supervisor";

const saved = process.env.PI_WEB_TRUSTED_HOSTS;
const savedAuth = process.env.PI_WEB_AUTH;
const savedToken = process.env.PI_WEB_LAUNCH_TOKEN;
afterEach(async () => {
	if (saved === undefined) delete process.env.PI_WEB_TRUSTED_HOSTS;
	else process.env.PI_WEB_TRUSTED_HOSTS = saved;
	if (savedAuth === undefined) delete process.env.PI_WEB_AUTH;
	else process.env.PI_WEB_AUTH = savedAuth;
	if (savedToken === undefined) delete process.env.PI_WEB_LAUNCH_TOKEN;
	else process.env.PI_WEB_LAUNCH_TOKEN = savedToken;
	await stopAll();
	resetRemoteSupervisor();
});

/** 拿一个当下空闲的端口 */
async function freePort(): Promise<number> {
	const server = net.createServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as net.AddressInfo;
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return port;
}

describe("remote entry guard", () => {
	it("blocks both entries without authentication and in development mode", () => {
		expect(remoteBlocked({})).toBe("auth");
		expect(remoteBlocked({ PI_WEB_AUTH: "0" })).toBe("auth");
		expect(remoteBlocked({ PI_WEB_AUTH: "1", NODE_ENV: "development" })).toBe("dev");
		expect(remoteBlocked({ PI_WEB_AUTH: "1", NODE_ENV: "production" })).toBeNull();
	});

	it("/api/remote refuses to start anything while authentication is off", async () => {
		delete process.env.PI_WEB_AUTH;
		for (const action of ["start", "start-lan"]) {
			const response = await POST(new Request("http://127.0.0.1/api/remote", { method: "POST", body: JSON.stringify({ action }) }));
			expect(response.status, action).toBe(409);
		}
		expect(remoteStatus().lan.running).toBe(false);
		expect(remoteStatus().public.running).toBe(false);
		expect(remoteStatus().blocked).toBe("auth");
	});

	it("/api/remote hands the launch token to the settings page only while authentication is on", async () => {
		process.env.PI_WEB_LAUNCH_TOKEN = "launch-tok";
		process.env.PI_WEB_AUTH = "1";
		expect((await (await GET()).json()).data.loginToken).toBe("launch-tok");
		delete process.env.PI_WEB_AUTH;
		expect((await (await GET()).json()).data.loginToken).toBeNull();
	});
});

describe("LAN entry lifecycle", () => {
	it("concurrent starts share one listener instead of racing into EADDRINUSE", async () => {
		const port = await freePort();
		const [first, second] = await Promise.all([startLan(port, "127.0.0.1", 1), startLan(port, "127.0.0.1", 1)]);
		expect(first.running).toBe(true);
		expect(second.running).toBe(true);
		expect(first.error).toBeNull();
		expect(second.error).toBeNull();
	});
});

describe("tunnel host allowlist", () => {
	it("adds the tunnel hostname without dropping existing entries", () => {
		process.env.PI_WEB_TRUSTED_HOSTS = "other.example.com";
		allowTunnelHost("https://abc-123.trycloudflare.com");
		expect(process.env.PI_WEB_TRUSTED_HOSTS).toBe("other.example.com,abc-123.trycloudflare.com");
	});

	it("is idempotent and normalizes case", () => {
		process.env.PI_WEB_TRUSTED_HOSTS = "";
		allowTunnelHost("https://ABC.trycloudflare.com");
		allowTunnelHost("https://abc.trycloudflare.com");
		expect(process.env.PI_WEB_TRUSTED_HOSTS).toBe("abc.trycloudflare.com");
	});

	it("removes only the tunnel hostname when the tunnel stops", () => {
		process.env.PI_WEB_TRUSTED_HOSTS = "other.example.com,abc.trycloudflare.com";
		disallowTunnelHost("https://abc.trycloudflare.com");
		expect(process.env.PI_WEB_TRUSTED_HOSTS).toBe("other.example.com");
	});

	it("ignores malformed URLs instead of corrupting the allowlist", () => {
		process.env.PI_WEB_TRUSTED_HOSTS = "keep.example.com";
		allowTunnelHost("not a url");
		disallowTunnelHost("not a url");
		expect(process.env.PI_WEB_TRUSTED_HOSTS).toBe("keep.example.com");
	});
});

describe("public URL capture", () => {
	it("takes the first cloudflared address and refuses to change it afterwards", () => {
		const catcher = createUrlCatcher();
		expect(catcher.feed("starting tunnel, please wait\n")).toBeNull();
		expect(catcher.feed("INF |  https://first-name-abc.trycloudflare.com  |\n")).toBe("https://first-name-abc.trycloudflare.com");
		// 之后再来一个地址不能顶掉已经生效的那个
		expect(catcher.feed("INF |  https://second-name-xyz.trycloudflare.com  |\n")).toBeNull();
		expect(catcher.url).toBe("https://first-name-abc.trycloudflare.com");
	});

	it("finds the address when it is split across chunks", () => {
		const catcher = createUrlCatcher();
		expect(catcher.feed("INF |  https://split-na")).toBeNull();
		expect(catcher.feed("me-abc.trycloudflare.com  |\n")).toBe("https://split-name-abc.trycloudflare.com");
	});

	it("ignores unrelated hostnames", () => {
		const catcher = createUrlCatcher();
		expect(catcher.feed("https://api.cloudflare.com ok\n")).toBeNull();
		expect(catcher.feed("https://example.com\n")).toBeNull();
		expect(catcher.url).toBeNull();
	});
});

describe("remote plugin config", () => {
	it("defaults the LAN entry on and reads its port from env", () => {
		expect(remoteLanEnabled({})).toBe(true);
		expect(remoteLanEnabled({ PIWEB_REMOTE_LAN: "0" })).toBe(false);
		expect(remoteLanEnabled({ PIWEB_REMOTE_LAN: "off" })).toBe(false);
		expect(remoteLanPort({})).toBe(30142);
		expect(remoteLanPort({ PIWEB_REMOTE_LAN_PORT: "40100" })).toBe(40100);
		expect(remoteLanPort({ PIWEB_REMOTE_LAN_PORT: "abc" })).toBe(30142);
	});

	it("prefers PIWEB_PORT as the forward target", () => {
		expect(piwebPort({ PIWEB_PORT: "30500", PORT: "1" })).toBe(30500);
		expect(piwebPort({ PORT: "30600" })).toBe(30600);
		expect(piwebPort({})).toBe(30141);
		expect(piwebPort({ PORT: "nope" })).toBe(30141);
	});

	it("lists real adapters first and drops proxy TUN addresses the phone can never reach", () => {
		const v4 = (address: string, internal = false) => ({ address, netmask: "255.255.255.0", family: "IPv4", mac: "00:00:00:00:00:00", internal, cidr: null }) as os.NetworkInterfaceInfo;
		// 照抄一台装了 Mihomo、VMware、WSL 的 Windows：只有 WLAN 那个是同一 WiFi 下手机能用的
		const addresses = lanAddresses({
			"vEthernet (WSL (Hyper-V firewall))": [v4("172.31.208.1")],
			"VMware Network Adapter VMnet8": [v4("192.168.110.1")],
			"以太网": [v4("169.254.80.44")],
			Mihomo: [v4("198.18.0.1")],
			WLAN: [v4("192.168.5.44")],
			"Loopback Pseudo-Interface 1": [v4("127.0.0.1", true)],
		});
		expect(addresses).toEqual(["192.168.5.44", "172.31.208.1", "192.168.110.1"]);
	});

	it("reports an idle status before anything starts", () => {
		resetRemoteSupervisor();
		const status = remoteStatus();
		expect(status.plugin).toBe("builtin-remote");
		expect(status.lan.running).toBe(false);
		expect(status.lan.urls).toEqual([]);
		expect(status.public.running).toBe(false);
		expect(status.public.url).toBeNull();
	});

	it("finds the PiWeb-managed engine under the agent directory", () => {
		expect(managedEnginePath()).toMatch(/web-bin[\\/]cloudflared(\.exe)?$/);
		expect(tunnelEngine()).toBeTruthy();
	});
});