import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import lockfile from "proper-lockfile";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ resetModelRuntime: vi.fn(), getModelRuntime: vi.fn() }));
vi.mock("../src/lib/pi", () => ({
	getAgentDir: () => process.env.PI_CODING_AGENT_DIR,
	resetModelRuntime: mocks.resetModelRuntime,
	getModelRuntime: mocks.getModelRuntime,
}));

import {
	CustomProvidersConflictError, CustomProvidersValidationError,
	preserveCustomProviderApiKeys, readCustomProviders, redactCustomProviderSecrets, writeCustomProviders,
} from "../src/lib/models-service";
import { GET, POST } from "../src/app/api/models/route";

let agentDir: string;
let file: string;
const provider = { baseUrl: "https://example.test/v1", api: "openai-completions", models: [{ id: "model-a" }] };

beforeEach(async () => {
	agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-model-config-"));
	file = path.join(agentDir, "models.json");
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
	vi.stubGlobal("fetch", vi.fn(() => { throw new Error("network is forbidden"); }));
	mocks.resetModelRuntime.mockReset();
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

describe("JSONC model configuration", () => {
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
		const saved = JSON.parse(await fs.readFile(file, "utf8"));
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
		expect(mocks.resetModelRuntime).toHaveBeenCalledOnce();
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
		expect(mocks.resetModelRuntime).not.toHaveBeenCalled();
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
		vi.spyOn(fs, "rename").mockRejectedValueOnce(Object.assign(new Error("rename denied"), { code: "EACCES" }));
		await expect(writeCustomProviders(JSON.stringify({ providers: { gateway: provider } }))).rejects.toThrow("rename denied");
		expect(await fs.readFile(file, "utf8")).toBe(original);
		expect(mocks.resetModelRuntime).not.toHaveBeenCalled();
		await expectOnlyConfig();
	});
});

describe("configuration revision and route contract", () => {
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

	it("retains the existing successful-save response with a revision", async () => {
		const response = await post(JSON.stringify({ providers: { gateway: provider } }), "missing");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ success: true, data: { requiresSessionReopen: true } });
	});

	it("returns a GET failure for a corrupt file before requesting the application model runtime", async () => {
		await fs.writeFile(file, "{broken");
		const response = await GET(new Request("http://localhost/api/models?custom=1"));
		expect(response.status).toBe(500);
		expect(await response.json()).toMatchObject({ success: false });
		expect(mocks.getModelRuntime).not.toHaveBeenCalled();
	});
});
