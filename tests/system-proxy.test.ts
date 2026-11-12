import { execFile, type execFileSync } from "node:child_process";
import http from "node:http";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { parseWindowsProxy, readSystemProxy } from "../scripts/system-proxy.mjs";
import { applyProxyEnv, nodeSupportsEnvProxy } from "../scripts/launcher.mjs";

const registry = (server: string, enabled = "0x1", bypass = "") => `
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings
    ProxyEnable    REG_DWORD    ${enabled}
    ProxyServer    REG_SZ    ${server}
    ProxyOverride    REG_SZ    ${bypass}
`;

describe("Windows system proxy detection", () => {
	it("reads a shared proxy and supported bypass entries", () => {
		expect(parseWindowsProxy(registry("127.0.0.1:7890", "0x1", "<local>;localhost;*.example.com;192.168.*"))).toEqual({
			http: "http://127.0.0.1:7890", https: "http://127.0.0.1:7890", noProxy: "localhost,*.example.com",
		});
	});

	it("keeps separate HTTP and HTTPS proxies and recognizes bypass-all", () => {
		expect(parseWindowsProxy(registry("http=proxy.local:8080;https=https://secure.local:8443;socks=localhost:1080", "1", "*"))).toEqual({
			http: "http://proxy.local:8080", https: "https://secure.local:8443", noProxy: "*",
		});
	});

	it.each([
		registry("127.0.0.1:7890", "0x0"), registry(""), registry("socks=localhost:1080"),
		registry("file:///bad"), registry("bad:99999"), "AutoConfigURL REG_SZ http://pac.local/proxy.pac",
	])("ignores disabled, missing or unsupported proxy settings", (output) => {
		expect(parseWindowsProxy(output)).toBeNull();
	});

	it("reads the registry without a shell or visible window and tolerates unavailable settings", () => {
		const run = vi.fn(() => registry("127.0.0.1:7890")) as unknown as typeof execFileSync;
		expect(readSystemProxy({ platform: "win32", run })).toMatchObject({ https: "http://127.0.0.1:7890" });
		expect(run).toHaveBeenCalledWith(expect.stringMatching(/reg\.exe$/), ["query", expect.stringContaining("Internet Settings")], expect.objectContaining({ windowsHide: true, timeout: 1500 }));
		expect(readSystemProxy({ platform: "linux", run })).toBeNull();
		expect(run).toHaveBeenCalledTimes(1);
		const broken = (() => { throw new Error("access denied"); }) as typeof execFileSync;
		expect(readSystemProxy({ platform: "win32", run: broken })).toBeNull();
	});

	it.skipIf(!nodeSupportsEnvProxy())("routes a real fetch through the detected proxy without external network access", async () => {
		const server = http.createServer((_request, response) => response.end("system-proxy-ok"));
		let tunnels = 0;
		server.on("connect", (_request, socket) => {
			tunnels++;
			socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
			socket.once("data", () => socket.end("HTTP/1.1 200 OK\r\nContent-Length: 15\r\nConnection: close\r\n\r\nsystem-proxy-ok"));
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		try {
			const port = (server.address() as { port: number }).port;
			const env = { NODE_ENV: process.env.NODE_ENV, ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(https?_proxy|all_proxy|no_proxy|node_use_env_proxy)$/i.test(key))) };
			applyProxyEnv(env, { systemProxy: parseWindowsProxy(registry(`127.0.0.1:${port}`)) });
			const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", 'console.log(await (await fetch("http://proxy-check.invalid/", {signal: AbortSignal.timeout(3000)})).text())'], { env, timeout: 5000, windowsHide: true });
			expect(stdout.trim()).toBe("system-proxy-ok");
			expect(tunnels).toBe(1);
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});
});
