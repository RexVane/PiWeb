import { describe, expect, it } from "vitest";
import { createServer } from "node:net";
import { automaticProxy, publicProxy, testProxyConnection, type ProxyChoice } from "../src/lib/proxy-status";

const system = { http: "http://127.0.0.1:7897", https: "http://127.0.0.1:7897" };
const automatic: ProxyChoice = { source: "system", ...system };
/** The probe needs Node's NODE_USE_ENV_PROXY support; unit cases pin it so the runner's version does not decide. */
const NODE_WITH_ENV_PROXY = "24.12.0";
const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
const runtimeSupportsEnvProxy = nodeMajor >= 24 || (nodeMajor === 22 && nodeMinor >= 21);

describe("proxy diagnostics", () => {
	it("shows Windows settings while ignoring injected startup proxy variables", () => {
		expect(automaticProxy({ HTTP_PROXY: "http://old:8080", PIWEB_PROXY_SOURCE: "system" }, system)).toEqual(automatic);
		expect(automaticProxy({ https_proxy: "http://env:3128" }, system)).toMatchObject({ source: "env", https: "http://env:3128" });
		expect(automaticProxy({ PIWEB_PROXY_SOURCE: "settings", HTTP_PROXY: "http://manual:8080", PIWEB_INHERITED_HTTP_PROXY: "http://env:3128" }, system)).toMatchObject({ source: "env", https: "http://env:3128" });
		expect(automaticProxy({}, null)).toEqual({ source: "none", http: null, https: null });
	});

	it("removes credentials and paths from displayed proxy addresses", () => {
		const displayed = publicProxy({ source: "env", http: "http://alice:secret@proxy.local:8080/private", https: "invalid" });
		expect(displayed).toEqual({ source: "env", http: "http://proxy.local:8080", https: null });
		expect(JSON.stringify(displayed)).not.toMatch(/alice|secret|private/);
	});

	it("uses the detected proxy for an empty input and the draft address for an override", async () => {
		const seen: string[] = [];
		const probe = async (proxy: string) => { seen.push(proxy); return { ok: true, status: 204 }; };
		expect(await testProxyConnection("", { automatic, probe, nodeVersion: NODE_WITH_ENV_PROXY })).toMatchObject({ ok: true, proxy: automatic });
		expect(await testProxyConnection(" http://user:pass@manual:8080 ", { automatic, probe, nodeVersion: NODE_WITH_ENV_PROXY })).toMatchObject({ ok: true, proxy: { source: "manual", https: "http://manual:8080" } });
		expect(seen).toEqual([system.https, "http://user:pass@manual:8080"]);
	});

	it.each([
		["not a proxy", "invalid"], ["file:///secret", "unsupported"], ["socks5://localhost:1080", "unsupported"], ["http://proxy:8080/path", "invalid"], ["http://127.0.0.1:0", "invalid"],
	])("rejects %s before attempting a network request", async (input, code) => {
		let calls = 0;
		const result = await testProxyConnection(input, { automatic, nodeVersion: NODE_WITH_ENV_PROXY, probe: async () => { calls++; return { ok: true, status: 204 }; } });
		expect(result).toMatchObject({ ok: false, code });
		expect(calls).toBe(0);
	});

	it("does not report an open port or an unexpected HTTP response as success", async () => {
		expect(await testProxyConnection("", { automatic, nodeVersion: NODE_WITH_ENV_PROXY, probe: async () => ({ ok: true, status: 200 }) })).toMatchObject({ ok: false, code: "http", status: 200 });
		expect(await testProxyConnection("", { automatic, nodeVersion: NODE_WITH_ENV_PROXY, probe: async () => ({ ok: false, code: "ECONNREFUSED" }) })).toMatchObject({ ok: false, code: "unreachable" });
		expect(await testProxyConnection("", { automatic, nodeVersion: NODE_WITH_ENV_PROXY, probe: async () => ({ ok: false, code: "UND_ERR_CONNECT_TIMEOUT" }) })).toMatchObject({ ok: false, code: "timeout" });
	});

	it("refuses to probe on a Node without env-proxy support", async () => {
		let calls = 0;
		const result = await testProxyConnection("http://127.0.0.1:3128", {
			automatic, nodeVersion: "22.19.0", probe: async () => { calls++; return { ok: true, status: 204 }; },
		});
		expect(result).toMatchObject({ ok: false, code: "unsupported" });
		expect(calls).toBe(0);
	});

	it("reports no detected proxy and never silently tests a direct connection", async () => {
		expect(await testProxyConnection("", { automatic: { source: "none", http: null, https: null }, probe: async () => { throw new Error("must not probe"); } })).toMatchObject({ ok: false, code: "no_proxy" });
	});

	it.skipIf(!runtimeSupportsEnvProxy)("uses the real probe to report a closed local proxy instead of reaching the target directly", async () => {
		const server = createServer();
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const port = (server.address() as { port: number }).port;
		await new Promise<void>((resolve) => server.close(() => resolve()));
		const result = await testProxyConnection(`http://127.0.0.1:${port}`, { automatic });
		expect(result).toMatchObject({ ok: false, code: "unreachable" });
	}, 12_000);
});
