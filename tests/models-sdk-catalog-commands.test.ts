import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, afterAll, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { createPiWebModelRuntime } from "../src/lib/model-runtime-safe";
import { InMemoryModelsStore } from "@earendil-works/pi-ai";
import { recycleFixture } from "./fixtures/recycle";
import { createSessionModelRuntime, releaseSessionModelRuntime } from "../src/lib/session-model-runtime";

const roots: string[] = [];
beforeAll(async () => {
	if (process.platform !== "win32") return;
	// The SDK otherwise picks the legacy WSL launcher before Git Bash on this
	// machine. Use an installed Git Bash so this is a working command probe.
	const gitExec = execFileSync("git", ["--exec-path"], { encoding: "utf8", windowsHide: true }).trim();
	const bashDir = path.resolve(gitExec, "../../../bin");
	await fs.access(path.join(bashDir, "bash.exe"));
	const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
	vi.stubEnv(pathKey, `${bashDir}${path.delimiter}${process.env[pathKey] ?? ""}`);
});
afterAll(() => vi.unstubAllEnvs());
afterEach(async () => { for (const root of roots.splice(0)) await recycleFixture(root); });
it.each(["config-key", "config-header", "stored-key"])("PiWeb's real SDK catalog initialization and refresh do not execute a %s command", async (kind) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-sdk-command-")); roots.push(root);
	vi.stubEnv("PI_CODING_AGENT_DIR", root);
	const marker = path.join(root, "executed");
	const markerBase64 = Buffer.from(marker).toString("base64");
	const command = `!\"${process.execPath.replace(/\\/g, "/")}\" -e \"require('fs').writeFileSync(Buffer.from('${markerBase64}','base64').toString(),'executed');process.stdout.write('command-secret')\"`;
	const config = { baseUrl: "https://catalog.example/v1", api: "openai-completions", models: [{ id: "probe", name: "Probe", contextWindow: 10000, maxTokens: 1000 }], ...(kind === "config-key" ? { apiKey: command } : {}), ...(kind === "config-header" ? { apiKey: "literal-secret", headers: { "X-Credential": command } } : {}) };
	const modelsPath = path.join(root, "models.json"); const authPath = path.join(root, "auth.json");
	await fs.writeFile(modelsPath, JSON.stringify({ providers: { auditprobe: config } }));
	await fs.writeFile(authPath, JSON.stringify(kind === "stored-key" ? { auditprobe: { type: "api_key", key: command } } : {}));
	const runtime = await createPiWebModelRuntime({ authPath, modelsPath, modelsStore: new InMemoryModelsStore(), allowModelNetwork: false });
	expect(runtime.getError()).toBeUndefined();
	expect(runtime.getModels("auditprobe").map((model) => model.id)).toContain("probe");
	await runtime.refresh({ allowNetwork: false });
	await runtime.getAvailable(); await runtime.checkAuth("auditprobe");
	const sessionRuntime = await createSessionModelRuntime(runtime);
	await sessionRuntime.getAvailable(); await sessionRuntime.checkAuth("auditprobe");
	await sessionRuntime.refresh({ allowNetwork: false });
	await releaseSessionModelRuntime(sessionRuntime);
	expect(await fs.stat(marker).then(() => true, () => false)).toBe(false);
	// Resolve request credentials without sending a model request. This proves
	// commands remain available at the explicitly requested authentication boundary.
	const auth = await runtime.getAuth("auditprobe");
	expect(await fs.readFile(marker, "utf8")).toBe("executed");
	expect(kind === "config-header" ? auth?.auth.headers?.["X-Credential"] : auth?.auth.apiKey).toBe("command-secret");
	await runtime.settleCredentialWrites();
});

it("keeps stored environment templates and escaping compatible with request authentication", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-sdk-template-")); roots.push(root);
	const authPath = path.join(root, "auth.json");
	const modelsPath = path.join(root, "models.json");
	await fs.writeFile(modelsPath, JSON.stringify({ providers: { auditprobe: { baseUrl: "https://catalog.example/v1", api: "openai-completions", models: [{ id: "probe" }] } } }));
	const cases = ["plain-key", "$TOKEN", "${TOKEN}", "pre-$TOKEN-post", "$$TOKEN", "$!literal", "${invalid $TOKEN}", "${unclosed $TOKEN"];
	for (const key of cases) {
		await fs.writeFile(authPath, JSON.stringify({ auditprobe: { type: "api_key", key, env: { TOKEN: "test-value" } } }));
		const runtime = await createPiWebModelRuntime({ authPath, modelsPath, modelsStore: new InMemoryModelsStore() });
		expect(await runtime.checkAuth("auditprobe")).toBeDefined();
		const store = (runtime as unknown as { credentials: { read(id: string): Promise<{ key: string }> } }).credentials;
		expect((await store.read("auditprobe")).key).toBe((await runtime.getAuth("auditprobe"))?.auth.apiKey);
		await runtime.settleCredentialWrites();
	}
});
