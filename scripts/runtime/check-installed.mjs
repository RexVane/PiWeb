#!/usr/bin/env node
/** Exercise the SDK and production startup inside the freshly installed artifact. */
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import next from "next";
import { isMainModule } from "../entrypoint.mjs";
import { PI_RUNTIME_PACKAGES, verifyPiRuntimePins } from "./pi-packages.mjs";

export async function checkInstalledRuntime(root = process.cwd()) {
	const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
	const version = verifyPiRuntimePins(manifest);
	for (const name of PI_RUNTIME_PACKAGES) {
		let dir = path.dirname(fileURLToPath(import.meta.resolve(name)));
		while (!fs.existsSync(path.join(dir, "package.json"))) {
			const parent = path.dirname(dir);
			if (parent === dir) throw new Error("package.json missing: " + name);
			dir = parent;
		}
		const actual = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).version;
		if (actual !== version) throw new Error(name + " resolved to " + actual + ", expected " + version);
	}
	await import("@earendil-works/pi-coding-agent");
	await import("@earendil-works/pi-ai");

	const app = next({ dev: false, dir: root });
	const server = http.createServer(app.getRequestHandler());
	const routes = ["/api/health", "/api/version", "/api/models", "/api/sessions", "/api/workspaces", "/api/pi-settings"];
	try {
		await app.prepare();
		await new Promise((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});
		const base = "http://127.0.0.1:" + server.address().port;
		for (const route of routes) {
			const response = await fetch(base + route, { signal: AbortSignal.timeout(30_000) });
			const body = await response.json();
			if (!response.ok || body.success !== true) {
				throw new Error(route + " failed: " + response.status + " " + JSON.stringify(body));
			}
		}
		const page = await fetch(base + "/", { signal: AbortSignal.timeout(30_000) });
		if (!page.ok || !(page.headers.get("content-type") ?? "").includes("text/html") || (await page.text()).length < 500) {
			throw new Error("production home page failed: " + page.status);
		}
		return { version, routes, homePage: true };
	} finally {
		if (server.listening) {
			server.closeAllConnections();
			await new Promise((resolve) => server.close(resolve));
		}
		await app.close();
	}
}

if (isMainModule(import.meta.url)) {
	try {
		console.log(JSON.stringify(await checkInstalledRuntime()));
		process.exit(0);
	} catch (error) {
		console.error(error);
		process.exit(1);
	}
}
