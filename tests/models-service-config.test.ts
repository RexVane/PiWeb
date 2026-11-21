import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { parse } from "jsonc-parser";
import lockfile from "proper-lockfile";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ refreshModelRuntime: vi.fn(), getModelRuntime: vi.fn() }));
vi.mock("../src/lib/pi", () => ({
	getAgentDir: () => process.env.PI_CODING_AGENT_DIR,
	refreshModelRuntime: mocks.refreshModelRuntime,
	refreshModelRuntimeIfFilesChanged: vi.fn(async () => false),
	modelRuntimeVersion: () => 0,
	getModelRuntime: mocks.getModelRuntime,
}));

import {
	CustomProvidersConflictError, CustomProvidersValidationError,
	invalidateModelList, preserveCustomProviderApiKeys, readCustomProviders, redactCustomProviderSecrets, resolveCustomModelCapabilities, writeCustomProviders,
} from "../src/lib/models-service";
import { GET, POST } from "../src/app/api/models/route";
import { customModelGaps, fillModelFields, modelDraftFromConfig, PI_MODEL_FALLBACKS, serializeProviderDraft } from "../src/lib/model-draft";

let agentDir: string;
let file: string;
const provider = { baseUrl: "https://example.test/v1", api: "openai-completions", models: [{ id: "model-a" }] };

beforeEach(async () => {
	agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-model-config-"));
	file = path.join(agentDir, "models.json");
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
	vi.stubGlobal("fetch", vi.fn(() => { throw new Error("network is forbidden"); }));
	mocks.refreshModelRuntime.mockReset().mockResolvedValue(undefined);
	mocks.getModelRuntime.mockReset().mockImplementation(() => { throw new Error("application runtime is forbidden during validation"); });
});

afterEach(async () => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	await fs.rm(agentDir, { recursive: true, force: true });
});

function post(content: string, revision?: unknown) {
	return POST(new Request("http://localhost/api/models", {
		method: "POST", headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ action: "saveCustomProviders", content, revision }),
	}));
}

async function expectOnlyConfig() {
	expect((await fs.readdir(agentDir)).sort()).toEqual(["models.json"]);
}

describe("automatic capability persistence", () => {
	it("persists exact official capabilities and retains manual limits, comments and keys after restart", async () => {
		vi.stubEnv("PI_OFFLINE", "1");
		const official = await ModelRuntime.create({ modelsPath: null, credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), allowModelNetwork: false, refreshOnCreate: false });
		const model = official.getModels("anthropic")[0];
		await fs.writeFile(file, `// retained comment\n${JSON.stringify({ providers: { gateway: { ...provider, apiKey: "secret-key", models: [{ id: model.id, contextWindow: 64000 }] } } })}`);
		const snapshot = await readCustomProviders();
		const result = await resolveCustomModelCapabilities(snapshot.revision);
		expect(result.filled).toBe(1);
		expect(result.customProviders.content).not.toContain("secret-key");
		const saved = JSON.parse(result.customProviders.content);
		expect(saved.providers.gateway.models[0]).toMatchObject({ contextWindow: 64000, maxTokens: model.maxTokens, input: model.input, reasoning: model.reasoning });
		expect(await fs.readFile(file, "utf8")).toContain("// retained comment");
		expect(await fs.readFile(file, "utf8")).toContain("secret-key");
		const restarted = await ModelRuntime.create({ modelsPath: file, credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), allowModelNetwork: false, refreshOnCreate: false });
		expect(restarted.getModel("gateway", model.id)).toMatchObject({ contextWindow: 64000, maxTokens: model.maxTokens, reasoning: model.reasoning });
		expect((await resolveCustomModelCapabilities(result.customProviders.revision)).filled).toBe(0);
		expect(customModelGaps(saved.providers)).toEqual([]);
		expect(mocks.getModelRuntime).not.toHaveBeenCalled();
	});

	it("uses configured endpoint metadata first and coalesces simultaneous resolution requests", async () => {
		let requests = 0;
		const server = createServer((_request, response) => {
			requests += 1;
			response.setHeader("Content-Type", "application/json");
			response.end(JSON.stringify({ data: [{ id: "model-a", context_window: 256000, max_output_tokens: 32000, input_modalities: ["text"], reasoning: false }] }));
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		try {
			vi.stubEnv("PI_WEB_ALLOW_PRIVATE_MODEL_DISCOVERY", "1");
			// CI 全局设 PI_OFFLINE=1；本用例要真发一次本机 HTTP 请求，必须显式关掉离线。
			vi.stubEnv("PI_OFFLINE", "0");
			const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
			await fs.writeFile(file, JSON.stringify({ providers: { gateway: { ...provider, baseUrl, apiKey: "test-key" } } }));
			const runtime = await ModelRuntime.create({ modelsPath: file, authPath: path.join(agentDir, "auth.json"), modelsStore: new InMemoryModelsStore(), allowModelNetwork: false, refreshOnCreate: false });
			await runtime.refresh({ allowNetwork: false });
			const checkAuth = vi.spyOn(runtime, "checkAuth");
			mocks.getModelRuntime.mockResolvedValue(runtime);
			expect(runtime.getRegisteredProviderIds()).not.toContain("gateway");
			expect(runtime.hasConfiguredAuth("gateway")).toBe(true);
			const snapshot = await readCustomProviders();
			const [one, two] = await Promise.all([resolveCustomModelCapabilities(snapshot.revision), resolveCustomModelCapabilities(snapshot.revision)]);
			expect(one).toEqual(two);
			expect(one.filled).toBe(1);
			expect(JSON.parse(one.customProviders.content).providers.gateway.models[0]).toMatchObject({ contextWindow: 256000, maxTokens: 32000, input: ["text"], reasoning: false });
			expect(mocks.refreshModelRuntime).toHaveBeenCalledTimes(1);
			expect(requests).toBe(1);
			expect(checkAuth).not.toHaveBeenCalled();
		} finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
	});

	it("does not overwrite an external edit made during endpoint detection", async () => {
		let external = "";
		const server = createServer((_request, response) => {
			void fs.writeFile(file, external).then(() => response.end(JSON.stringify({ data: [{ id: "model-a", context_window: 256000 }] })));
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		try {
			vi.stubEnv("PI_WEB_ALLOW_PRIVATE_MODEL_DISCOVERY", "1");
			// 同上：离线短路会让服务端根本不发请求，冲突场景就不存在了。
			vi.stubEnv("PI_OFFLINE", "0");
			const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
			const config = { providers: { gateway: { ...provider, baseUrl, apiKey: "test-key" } } };
			external = JSON.stringify({ ...config, external: true });
			await fs.writeFile(file, JSON.stringify(config));
			const runtime = await ModelRuntime.create({ modelsPath: file, authPath: path.join(agentDir, "auth.json"), modelsStore: new InMemoryModelsStore(), allowModelNetwork: false, refreshOnCreate: false });
			await runtime.refresh({ allowNetwork: false });
			mocks.getModelRuntime.mockResolvedValue(runtime);
			await expect(resolveCustomModelCapabilities((await readCustomProviders()).revision)).rejects.toThrow(CustomProvidersConflictError);
			expect(await fs.readFile(file, "utf8")).toBe(external);
			expect(mocks.refreshModelRuntime).not.toHaveBeenCalled();
		} finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
	});

	it.each(["command-key", "command-header", "oauth", "malformed-auth"])("does not execute unsafe background authentication (%s) or invent unknown limits", async (kind) => {
		const config = { providers: { gateway: { ...provider, apiKey: kind === "command-key" ? "!must-not-execute" : "plain-key", ...(kind === "command-header" ? { headers: { Authorization: "!must-not-execute" } } : {}) } } };
		await fs.writeFile(file, JSON.stringify(config));
		if (kind === "oauth") await fs.writeFile(path.join(agentDir, "auth.json"), JSON.stringify({ gateway: { type: "oauth" } }));
		if (kind === "malformed-auth") await fs.writeFile(path.join(agentDir, "auth.json"), "{broken");
		const result = await resolveCustomModelCapabilities((await readCustomProviders()).revision);
		expect(result.filled).toBe(0);
		expect(await fs.readFile(file, "utf8")).toBe(JSON.stringify(config));
		expect(mocks.getModelRuntime).not.toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();
	});

	it("rejects stale configuration revisions without discovery or writes", async () => {
		await fs.writeFile(file, JSON.stringify({ providers: { gateway: provider } }));
		await expect(resolveCustomModelCapabilities("missing")).rejects.toThrow(CustomProvidersConflictError);
		expect(mocks.getModelRuntime).not.toHaveBeenCalled();
		expect(mocks.refreshModelRuntime).not.toHaveBeenCalled();
	});
});

describe("JSONC model configuration", () => {
	it("allows an emptied builtin overlay after restoring its hidden credential", async () => {
		await fs.writeFile(file, JSON.stringify({ providers: { openai: { baseUrl: "https://gateway.example/v1", apiKey: "retained-key" } } }));
		await writeCustomProviders(JSON.stringify({ providers: { openai: {} } }));
		expect(JSON.parse(await fs.readFile(file, "utf8")).providers.openai).toEqual({ apiKey: "retained-key" });
	});
	it("redacts and restores model-level credential headers by model identity across reordering", () => {
		const original = JSON.stringify({ providers: { gateway: { ...provider, models: [{ id: "first", headers: { "X-Credential": "model-secret", Accept: "application/json" } }, { id: "second" }], modelOverrides: { builtin: { headers: { Authorization: "override-secret" } } } } } });
		const redacted = redactCustomProviderSecrets(original);
		expect(redacted.content).not.toContain("model-secret"); expect(redacted.content).not.toContain("override-secret");
		const next = JSON.parse(redacted.content); next.providers.gateway.models.reverse();
		const restored = JSON.parse(preserveCustomProviderApiKeys(JSON.stringify(next), original));
		expect(restored.providers.gateway.models[1].headers).toEqual({ "X-Credential": "model-secret", Accept: "application/json" });
		expect(restored.providers.gateway.modelOverrides.builtin.headers.Authorization).toBe("override-secret");
	});
	it("redacts sensitive custom headers and preserves them when a safe form edit is saved", async () => {
		await fs.writeFile(file, JSON.stringify({ providers: { gateway: { ...provider, headers: { Authorization: "Bearer secret", "x-api-key": "secret-key", "X-Credential": "credential-secret", "x-password": "password-secret", "x-command": "!never-run", "x-custom": "safe" } } } }));
		const read = await readCustomProviders();
		expect(read.content).not.toContain("Bearer secret"); expect(read.content).not.toContain("secret-key"); expect(read.content).not.toContain("never-run");
		expect(read.content).not.toContain("credential-secret"); expect(read.content).not.toContain("password-secret");
		const incoming = JSON.parse(read.content); incoming.providers.gateway.name = "Changed";
		await writeCustomProviders(JSON.stringify(incoming), read.revision);
		const saved = JSON.parse(await fs.readFile(file, "utf8"));
		expect(saved.providers.gateway.headers).toEqual({ Authorization: "Bearer secret", "x-api-key": "secret-key", "X-Credential": "credential-secret", "x-password": "password-secret", "x-command": "!never-run", "x-custom": "safe" });
	});
	it("the explicit default-completion values match the installed SDK's effective defaults", async () => {
		await fs.writeFile(file, JSON.stringify({ providers: { gateway: provider } }));
		const runtime = await ModelRuntime.create({ modelsPath: file, credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), allowModelNetwork: false, refreshOnCreate: false });
		expect(runtime.getError()).toBeUndefined();
		expect(runtime.getModel("gateway", "model-a")).toMatchObject({
			contextWindow: PI_MODEL_FALLBACKS.contextWindow,
			maxTokens: PI_MODEL_FALLBACKS.maxTokens,
			input: PI_MODEL_FALLBACKS.vision ? ["text", "image"] : ["text"],
			reasoning: PI_MODEL_FALLBACKS.reasoning,
		});
	});

	it("persists audit capacities and false capabilities for a fresh SDK runtime after restart", async () => {
		await fs.writeFile(file, JSON.stringify({ providers: { gateway: provider } }));
		const snapshot = await readCustomProviders();
		const config = JSON.parse(snapshot.content);
		const filled = fillModelFields(config.providers, [{ provider: "gateway", index: 0, id: "model-a", contextWindow: 256000, maxTokens: 32000, vision: false, reasoning: false }]);
		const result = await post(JSON.stringify({ ...config, providers: filled.providers }), snapshot.revision);
		expect(result.status).toBe(200);
		const persisted = JSON.parse((await readCustomProviders()).content);
		expect(customModelGaps(persisted.providers)).toEqual([]);
		const restarted = await ModelRuntime.create({ modelsPath: file, credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), allowModelNetwork: false, refreshOnCreate: false });
		expect(restarted.getError()).toBeUndefined();
		expect(restarted.getModel("gateway", "model-a")).toMatchObject({ contextWindow: 256000, maxTokens: 32000, input: ["text"], reasoning: false });
		expect(fetch).not.toHaveBeenCalled();
	});

	it("round-trips BOM, comments, trailing commas, opaque fields, and inline keys without executing them", async () => {
		const previous = '\uFEFF{\n// existing settings\n"opaque":{"keep":[1,2,]},\n"providers":{"gateway":{\n"baseUrl":"https://example.test/v1", "api":"openai-completions",\n"apiKey":"!must-not-execute", "headers":{"x-custom":"value"},\n"unknownProvider":{"keep":true}, "models":[{"id":"m","unknownModel":[1,2],"samplingParams":{"top_k":0},}],\n},},\n}';
		await fs.writeFile(file, previous);
		const read = await readCustomProviders();
		expect(read.exists).toBe(true);
		expect(read.revision).toBe(createHash("sha256").update(previous).digest("hex"));
		expect(read.secretProviderIds).toEqual(["gateway"]);
		expect(read.content).not.toContain("must-not-execute");
		const incoming = JSON.parse(read.content);
		incoming.providers.gateway.name = "New display name";
		const create = vi.spyOn(ModelRuntime, "create");
		await writeCustomProviders(JSON.stringify(incoming), read.revision);
		const rawSaved = await fs.readFile(file, "utf8");
		const saved = parse(rawSaved.replace(/^\uFEFF/, ""), [], { allowTrailingComma: true });
		expect(rawSaved.startsWith("\uFEFF")).toBe(true);
		expect(rawSaved).toContain("// existing");
		expect(saved.opaque).toEqual({ keep: [1, 2] });
		expect(saved.providers.gateway).toMatchObject({
			apiKey: "!must-not-execute", name: "New display name", unknownProvider: { keep: true },
			models: [{ id: "m", unknownModel: [1, 2], samplingParams: { top_k: 0 } }],
		});
		expect(create).toHaveBeenCalledTimes(2);
		for (const [options] of create.mock.calls) {
			expect(options).toMatchObject({ allowModelNetwork: false, refreshOnCreate: false });
			expect(options?.credentials).toBeDefined();
			expect(options?.modelsStore).toBeDefined();
			expect(path.dirname(options!.modelsPath!)).toBe(agentDir);
		}
		expect(fetch).not.toHaveBeenCalled();
		expect(mocks.getModelRuntime).not.toHaveBeenCalled();
		expect(mocks.refreshModelRuntime).toHaveBeenCalledOnce();
		await expectOnlyConfig();
	});

	it("accepts JSONC input and a model-level api exactly as the SDK does", async () => {
		await writeCustomProviders('{ /* client comment */ "providers":{"gateway":{"baseUrl":"https://example.test/v1","models":[{"id":"m","api":"openai-completions",},],},},}', "missing");
		expect(JSON.parse(await fs.readFile(file, "utf8")).providers.gateway.models[0].api).toBe("openai-completions");
		await expectOnlyConfig();
	});

	it("treats only ENOENT as missing and creates the first file atomically", async () => {
		expect(await readCustomProviders()).toEqual({
			content: JSON.stringify({ providers: {} }, null, 2), exists: false, secretProviderIds: [], revision: "missing",
		});
		await writeCustomProviders(JSON.stringify({ providers: { gateway: provider } }), "missing");
		expect((await readCustomProviders()).exists).toBe(true);
		await expectOnlyConfig();
	});

	it.each([
		"{broken json", "", "[]", "null", '{"providers":[]}', '{"providers":{"gateway":null}}',
		'{"providers":{}} trailing', '{"providers":{"gateway":{"apiKey":"SECRET_DO_NOT_LEAK",}}',
	])("fails closed for malformed existing content %#", async (content) => {
		await fs.writeFile(file, content);
		await expect(readCustomProviders()).rejects.toThrow(CustomProvidersValidationError);
		await expect(writeCustomProviders('{"providers":{}}')).rejects.toThrow();
		expect(await fs.readFile(file, "utf8")).toBe(content);
		expect(mocks.refreshModelRuntime).not.toHaveBeenCalled();
		await expectOnlyConfig();
	});

	it("never exposes secret source excerpts in parser errors", () => {
		expect(() => redactCustomProviderSecrets('{"providers":{"gateway":{"apiKey":"SECRET_DO_NOT_LEAK",}}')).toThrow(/JSONC/);
		try {
			redactCustomProviderSecrets('{"providers":{"gateway":{"apiKey":"SECRET_DO_NOT_LEAK",}}');
		} catch (error) {
			expect(String(error)).not.toContain("SECRET_DO_NOT_LEAK");
		}
	});

	it("does not overwrite an old schema-invalid file with a valid new one", async () => {
		const original = JSON.stringify({ providers: { gateway: { ...provider, headers: { invalid: 7 } } } });
		await fs.writeFile(file, original);
		await expect(writeCustomProviders('{"providers":{}}')).rejects.toThrow(/schema/);
		expect(await fs.readFile(file, "utf8")).toBe(original);
		await expectOnlyConfig();
	});

	it("propagates read permission failures without overwriting or reporting missing", async () => {
		const original = JSON.stringify({ providers: { gateway: { ...provider, apiKey: "key" } } });
		await fs.writeFile(file, original);
		const readFile = fs.readFile.bind(fs);
		const error = Object.assign(new Error("EACCES denied"), { code: "EACCES" });
		vi.spyOn(fs, "readFile").mockImplementation((...args: Parameters<typeof fs.readFile>) => {
			if (String(args[0]) === file) return Promise.reject(error);
			return readFile(...args);
		});
		await expect(readCustomProviders()).rejects.toThrow("EACCES");
		await expect(writeCustomProviders('{"providers":{}}')).rejects.toThrow("EACCES");
		expect(await readFile(file, "utf8")).toBe(original);
		await expectOnlyConfig();
	});

	it.each([
		{ apiKey: 123 }, { apiKey: "" }, { headers: { bad: false } }, { authHeader: "yes" },
		{ models: [{ id: "m", input: ["video"] }] }, { models: [{ id: "m", reasoning: "true" }] },
		{ models: [{ id: "m", contextWindow: 1.5 }] }, { models: [{ id: "m", maxTokens: 0 }] },
		{ models: [{ id: "m", cost: { input: 1 } }] }, { modelOverrides: { m: { maxTokens: -1 } } },
	])("validates the full SDK schema and positive integer limits before replacing the file %#", async (invalid) => {
		await fs.writeFile(file, '{"providers":{}}');
		await expect(writeCustomProviders(JSON.stringify({ providers: { gateway: { ...provider, ...invalid } } }))).rejects.toThrow();
		expect(await fs.readFile(file, "utf8")).toBe('{"providers":{}}');
		await expectOnlyConfig();
	});

	it("preserves missing/undefined keys, replaces explicit strings, and deletes explicit null", async () => {
		await fs.writeFile(file, JSON.stringify({ providers: { gateway: { ...provider, apiKey: "secret" } } }));
		await writeCustomProviders(JSON.stringify({ providers: { gateway: { ...provider, apiKey: undefined } } }));
		expect(JSON.parse(await fs.readFile(file, "utf8")).providers.gateway.apiKey).toBe("secret");
		await writeCustomProviders(JSON.stringify({ providers: { gateway: { ...provider, apiKey: "replacement" } } }));
		expect(JSON.parse(await fs.readFile(file, "utf8")).providers.gateway.apiKey).toBe("replacement");
		await writeCustomProviders(JSON.stringify({ providers: { gateway: { ...provider, apiKey: null } } }));
		expect(JSON.parse(await fs.readFile(file, "utf8")).providers.gateway.apiKey).toBeUndefined();
		await writeCustomProviders('{"providers":{}}');
		expect(JSON.parse(await fs.readFile(file, "utf8")).providers).toEqual({});
	});

	it("handles __proto__ as opaque JSON data, not an inherited provider or secret", () => {
		const old = '{"__proto__":{"opaque":true},"providers":{"__proto__":{"apiKey":"proto-secret"}}}';
		const result = redactCustomProviderSecrets(old);
		expect(result.secretProviderIds).toEqual(["__proto__"]);
		expect(JSON.parse(result.content).__proto__).toEqual({ opaque: true });
		expect(result.content).not.toContain("proto-secret");
		expect(JSON.parse(preserveCustomProviderApiKeys('{"providers":{"__proto__":{}}}', old)).providers.__proto__.apiKey).toBe("proto-secret");
	});

	it("keeps the original file and cleans staging files when rename fails", async () => {
		const original = '{"providers":{}}';
		await fs.writeFile(file, original);
		vi.spyOn(fs, "rename").mockRejectedValue(Object.assign(new Error("rename denied"), { code: "EACCES" }));
		await expect(writeCustomProviders(JSON.stringify({ providers: { gateway: provider } }))).rejects.toThrow("rename denied");
		expect(await fs.readFile(file, "utf8")).toBe(original);
		expect(mocks.refreshModelRuntime).not.toHaveBeenCalled();
		await expectOnlyConfig();
	});
});

describe("configuration revision and route contract", () => {
	it("retries a transient sharing failure without losing the requested model configuration", async () => {
		await fs.writeFile(file, '{"providers":{}}');
		const rename = vi.spyOn(fs, "rename").mockRejectedValueOnce(Object.assign(new Error("occupied"), { code: "EPERM" }));
		await writeCustomProviders(JSON.stringify({ providers: { gateway: provider } }));
		expect(rename).toHaveBeenCalledTimes(2);
		expect(JSON.parse(await fs.readFile(file, "utf8")).providers.gateway.models[0].id).toBe("model-a");
		await expectOnlyConfig();
	});
	it("refuses to overwrite an external edit made while waiting to replace the configuration", async () => {
		await fs.writeFile(file, '{"providers":{}}');
		const external = '{"providers":{},"external":true}';
		const rename = vi.spyOn(fs, "rename").mockImplementationOnce(async () => {
			await fs.writeFile(file, external);
			throw Object.assign(new Error("occupied"), { code: "EBUSY" });
		});
		await expect(writeCustomProviders(JSON.stringify({ providers: { gateway: provider } }))).rejects.toThrow(CustomProvidersConflictError);
		expect(rename).toHaveBeenCalledTimes(1);
		expect(await fs.readFile(file, "utf8")).toBe(external);
		expect(mocks.refreshModelRuntime).not.toHaveBeenCalled();
		await expectOnlyConfig();
	});
	it("leaves model-catalog compression to the HTTP layer so the Next adapter receives valid JSON", async () => {
		const runtime = await ModelRuntime.create({ modelsPath: null, credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), allowModelNetwork: false, refreshOnCreate: false });
		mocks.getModelRuntime.mockResolvedValue(runtime);
		invalidateModelList();
		try {
			const response = await GET(new Request("http://localhost/api/models?full=1", { headers: { "Accept-Encoding": "gzip, deflate" } }));
			const body = await response.json();
			expect(response.status, body.error).toBe(200);
			expect(response.headers.get("content-encoding")).toBeNull();
			expect(response.headers.get("cache-control")).toBe("no-store");
			expect(body.success).toBe(true);
			expect(body.data.models.length).toBeGreaterThan(0);
			expect(JSON.stringify(body).length).toBeGreaterThan(2048);
		} finally {
			invalidateModelList();
		}
	});

	it("rejects stale revisions before merging keys, even when the incoming JSON is invalid", async () => {
		await fs.writeFile(file, JSON.stringify({ providers: { gateway: { ...provider, apiKey: "new-secret" } } }));
		const original = await fs.readFile(file, "utf8");
		await expect(writeCustomProviders("invalid incoming", "missing")).rejects.toThrow(CustomProvidersConflictError);
		expect(await fs.readFile(file, "utf8")).toBe(original);
		await expectOnlyConfig();
	});

	it("lets only one simultaneous edit of the same revision commit", async () => {
		await fs.writeFile(file, '{"providers":{}}');
		const { revision } = await readCustomProviders();
		const results = await Promise.allSettled([
			writeCustomProviders(JSON.stringify({ providers: { first: provider } }), revision),
			writeCustomProviders(JSON.stringify({ providers: { second: provider } }), revision),
		]);
		expect(results[0].status).toBe("fulfilled");
		expect(results[1]).toMatchObject({ status: "rejected", reason: expect.any(CustomProvidersConflictError) });
		expect(Object.keys(JSON.parse(await fs.readFile(file, "utf8")).providers)).toEqual(["first"]);
		await expectOnlyConfig();
	});

	it("waits for the external lock and rejects a baseline changed by that writer", async () => {
		await fs.writeFile(file, '{"providers":{}}');
		const { revision } = await readCustomProviders();
		let release: (() => Promise<void>) | undefined = await lockfile.lock(file, { realpath: false });
		const pending = writeCustomProviders(JSON.stringify({ providers: { gateway: provider } }), revision);
		const rejected = expect(pending).rejects.toThrow(CustomProvidersConflictError);
		try {
			await new Promise((resolve) => setTimeout(resolve, 60));
			expect(await fs.readFile(file, "utf8")).toBe('{"providers":{}}');
			await fs.writeFile(file, '{"providers":{},"external":true}');
			await release();
			release = undefined;
			await rejected;
			expect(JSON.parse(await fs.readFile(file, "utf8")).external).toBe(true);
		} finally {
			if (release) await release();
			await pending.catch(() => undefined);
		}
	});

	it("returns 409 for conflicts and 400 for malformed revision/schema", async () => {
		await fs.writeFile(file, '{"providers":{}}');
		const conflict = await post('{"providers":{}}', "missing");
		expect(conflict.status).toBe(409);
		expect(await conflict.json()).toMatchObject({ success: false });
		expect((await post('{"providers":{}}', null)).status).toBe(400);
		expect((await post('{"providers":{}}', "invalid")).status).toBe(400);
		expect((await post('{"providers":[]}')).status).toBe(400);
		expect(await fs.readFile(file, "utf8")).toBe('{"providers":{}}');
	});

	it("returns a successful revisioned save without requiring the session to reopen", async () => {
		const response = await post(JSON.stringify({ providers: { gateway: provider } }), "missing");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ success: true, data: { requiresSessionReopen: false } });
	});

	it("returns a GET failure for a corrupt file before requesting the application model runtime", async () => {
		await fs.writeFile(file, "{broken");
		const response = await GET(new Request("http://localhost/api/models?custom=1"));
		expect(response.status).toBe(500);
		expect(await response.json()).toMatchObject({ success: false });
		expect(mocks.getModelRuntime).not.toHaveBeenCalled();
	});

	it("redacts Bearer/Basic header values regardless of header name and deletes stored secret headers when cleared via serializeProviderDraft", async () => {
		await writeCustomProviders(JSON.stringify({
			providers: {
				gw: {
					baseUrl: "https://example.com/v1",
					apiKey: "k",
					api: "openai-completions",
					headers: { "X-Api-Key": "s", "CF-Access-Assertion": "Bearer eyJsecret" },
					models: [{ id: "m1" }],
				},
			},
		}), "missing");
		const read = await readCustomProviders();
		expect(read.content).not.toContain("eyJsecret");
		expect(read.secretHeaderKeys).toEqual({ gw: ["X-Api-Key", "CF-Access-Assertion"] });

		const next = JSON.parse(read.content);
		next.providers.gw = serializeProviderDraft(next.providers.gw, {
			baseUrl: "https://example.com/v1",
			api: "openai-completions",
			models: next.providers.gw.models.map(modelDraftFromConfig),
			headers: {},
		});
		await writeCustomProviders(JSON.stringify(next), read.revision);
		const saved = JSON.parse(await fs.readFile(file, "utf8"));
		expect(saved.providers.gw.headers).toBeUndefined();
		expect(saved.providers.gw.apiKey).toBe("k");
	});
});
