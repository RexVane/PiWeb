import fs from "node:fs/promises";
import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels, type Model, type Api } from "@earendil-works/pi-ai";
import { ThinkingPolicy, modelThinkingMetadata, probeThinkingInBackground, type ThinkingPolicyOptions } from "../src/lib/automatic-thinking";
import { thinkingRowsToMap } from "../src/lib/thinking-config";
import { createPiWebModelRuntime } from "../src/lib/model-runtime-safe";
import { recycleFixture } from "./fixtures/recycle";

let root: string;
const policies: ThinkingPolicy[] = [];
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-auto-thinking-")); vi.stubEnv("PI_CODING_AGENT_DIR", root); });
afterEach(async () => { for (const policy of policies.splice(0)) { policy.stop(); await policy.settle(); } vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.unstubAllEnvs(); await recycleFixture(root); });
const model = (patch: Partial<Model<Api>> = {}): Model<Api> => ({ provider: "custom", id: "unknown-reasoner", name: "Model", api: "openai-completions", baseUrl: "https://models.invalid/v1", reasoning: true,
	input: ["text"], contextWindow: 100000, maxTokens: 2048, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, ...patch });
const runtime = { hasConfiguredAuth: () => true, getRegisteredProviderIds: () => [] } as unknown as ModelRuntime;
const map = thinkingRowsToMap([{ level: "low", value: "low" }, { level: "high", value: "high" }, { level: "max", value: "max" }]);
function policy(options: ThinkingPolicyOptions = {}, catalog: ConstructorParameters<typeof ThinkingPolicy>[0] = []) {
	const service = new ThinkingPolicy(catalog, root, options); policies.push(service); return service;
}

it("uses official levels immediately without scheduling a paid probe or mutating the catalog model", async () => {
	const probe = vi.fn();
	const service = policy({ allowBackground: true, probe }, [{ provider: "zai", id: "glm-5.3-flash", reasoning: true, thinkingLevelMap: map }]);
	const original = model({ id: "glm-5.3-flash-background" });
	const effective = service.resolve(original, runtime);
	expect(getSupportedThinkingLevels(effective)).toEqual(["low", "high", "max"]);
	expect(modelThinkingMetadata(effective)?.source).toBe("official");
	expect(service.resolve(effective, runtime)).toBe(effective); // no double-wrapping/source drift
	expect(original.thinkingLevelMap).toBeUndefined();
	await service.settle(); expect(probe).not.toHaveBeenCalled();
});

it("always preserves manual mappings, including user additions beyond the official defaults", async () => {
	const probe = vi.fn(); const service = policy({ allowBackground: true, probe });
	const original = model({ thinkingLevelMap: { ...map, medium: "deep", xhigh: "very-deep" } });
	expect(service.resolve(original, runtime)).toBe(original);
	expect(modelThinkingMetadata(original)?.source).toBe("custom");
	await service.settle(); expect(probe).not.toHaveBeenCalled();
});

it("uses the Pi catalog levels for GPT-6.2 Astra on a compatible provider", async () => {
	const modelsPath = path.join(root, "models.json");
	await fs.writeFile(modelsPath, JSON.stringify({
		providers: {
			agentrouter: {
				api: "openai-responses",
				baseUrl: "https://models.invalid/v1",
				apiKey: "offline-key",
				models: [{ id: "gpt-6.2-astra", reasoning: true }],
			},
		},
	}));
	const runtime = await createPiWebModelRuntime({
		modelsPath,
		authPath: path.join(root, "auth.json"),
		allowModelNetwork: false,
	});
	const astra = runtime.getModel("agentrouter", "gpt-6.2-astra")!;
	expect(modelThinkingMetadata(astra)).toMatchObject({
		source: "official",
		status: "none",
		officialModel: "openai/gpt-6.2-astra",
	});
	expect(getSupportedThinkingLevels(astra)).toEqual(["low", "medium", "high", "xhigh", "max"]);
});

it("deduplicates background work, caches only levels, survives restart and never writes models.json", async () => {
	const file = path.join(root, "models.json"); const content = '{"providers":{"custom":{"apiKey":"secret-must-not-be-cached"}}}';
	await fs.writeFile(file, content);
	let finish!: (value: { map: typeof map }) => void;
	const probe = vi.fn(() => new Promise<{ map: typeof map }>((resolve) => { finish = resolve; }));
	const service = policy({ allowBackground: true, probe });
	const original = model();
	const pending = service.resolve(original, runtime);
	for (let i = 0; i < 10; i++) service.resolve(original, runtime);
	await Promise.resolve(); await Promise.resolve();
	expect(probe).toHaveBeenCalledTimes(1);
	expect(modelThinkingMetadata(pending)?.status).toBe("queued");
	finish({ map }); await service.settle();
	const effective = service.resolve(original, runtime);
	expect(modelThinkingMetadata(effective)).toMatchObject({ source: "probe", status: "cached" });
	expect(getSupportedThinkingLevels(effective)).toEqual(["low", "high", "max"]);
	expect(await fs.readFile(file, "utf8")).toBe(content);
	expect(await fs.readFile(service.file, "utf8")).not.toContain("secret-must-not-be-cached");
	const restarted = policy({ allowBackground: true, probe }); await restarted.load();
	expect(getSupportedThinkingLevels(restarted.resolve(original, runtime))).toEqual(["low", "high", "max"]);
	await restarted.settle(); expect(probe).toHaveBeenCalledTimes(1);
});

it("keeps endpoints and model IDs separate in the cache and serializes probes", async () => {
	let active = 0; let maxActive = 0;
	const probe = vi.fn(async () => { active++; maxActive = Math.max(active, maxActive); await Promise.resolve(); active--; return { map }; });
	const service = policy({ allowBackground: true, probe });
	service.resolve(model(), runtime);
	service.resolve(model({ id: "another" }), runtime);
	service.resolve(model({ baseUrl: "https://another.invalid/v1" }), runtime);
	await service.settle();
	expect(probe).toHaveBeenCalledTimes(3); expect(maxActive).toBe(1);
});

it("treats failures as inconclusive, retries only after cooldown and stops a provider after 429", async () => {
	let now = Date.now();
	const probe = vi.fn(async () => ({ rateLimited: true }));
	const service = policy({ allowBackground: true, probe, now: () => now });
	const original = model(); service.resolve(original, runtime); service.resolve(model({ id: "second" }), runtime);
	await service.settle(); expect(probe).toHaveBeenCalledTimes(1);
	expect(getSupportedThinkingLevels(service.resolve(original, runtime))).toEqual(["off", "minimal", "low", "medium", "high"]);
	await service.settle(); expect(probe).toHaveBeenCalledTimes(1);
	now += 60 * 60 * 1000 + 1;
	service.resolve(original, runtime); await service.settle(); expect(probe).toHaveBeenCalledTimes(2);
});

it("discards queued work when endpoint/credential configuration changes before it starts", async () => {
	const probe = vi.fn(async () => ({ map })); const service = policy({ allowBackground: true, probe });
	service.resolve(model(), runtime);
	writeFileSync(path.join(root, "models.json"), "{}");
	await service.settle();
	expect(probe).not.toHaveBeenCalled();
});

it("merges independent cache writers rather than dropping another model's cached levels", async () => {
	const probe = vi.fn(async () => ({ map }));
	const one = policy({ allowBackground: true, probe }); const two = policy({ allowBackground: true, probe });
	await one.load(); await two.load();
	one.resolve(model(), runtime); await one.settle();
	two.resolve(model({ id: "other" }), runtime); await two.settle();
	const persisted = JSON.parse(await fs.readFile(one.file, "utf8"));
	expect(Object.keys(persisted.entries)).toHaveLength(2);
});

it("does not run background requests in test/offline mode", async () => {
	const probe = vi.fn(); const service = policy({ probe }); service.resolve(model(), runtime);
	await service.settle(); expect(probe).not.toHaveBeenCalled();
});

it.each(["command-key", "command-header", "oauth"])("does not execute %s authentication during automatic background work", async (kind) => {
	await fs.writeFile(path.join(root, "models.json"), JSON.stringify({ providers: { custom: { api: "openai-completions", baseUrl: "https://models.invalid/v1",
		apiKey: kind === "command-key" ? "!must-not-execute" : "offline-key", ...(kind === "command-header" ? { headers: { "X-Key": "!must-not-execute" } } : {}),
		models: [{ id: "unknown-reasoner", reasoning: true }],
	} } }));
	if (kind === "oauth") await fs.writeFile(path.join(root, "auth.json"), JSON.stringify({ custom: { type: "oauth", access: "unused", refresh: "unused", expires: Date.now() + 60000 } }));
	const getAuth = vi.fn();
	const streamSimple = vi.fn(() => { throw new Error("Unsafe background request"); });
	const rt = { ...runtime, getAuth, streamSimple } as unknown as ModelRuntime;
	const network = vi.fn(async () => { throw new Error("No paid requests"); }); vi.stubGlobal("fetch", network);
	const service = policy({ allowBackground: true });
	service.resolve(model(), rt);
	await service.settle();
	expect(getAuth).not.toHaveBeenCalled(); expect(streamSimple).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled();
});

it("uses a negative control and short requests to cache protocol-accepted levels", async () => {
	const calls: Array<{ effort?: string; maxTokens: number }> = [];
	const fake = { streamSimple: (candidate: Model<Api>, _context: unknown, options: { reasoning?: string; maxTokens: number; fetch: typeof fetch }) => ({ result: async () => {
		const effort = candidate.reasoning ? candidate.thinkingLevelMap?.[(options.reasoning ?? "off") as keyof typeof candidate.thinkingLevelMap] : undefined;
		const response = await options.fetch("https://models.invalid/v1", { method: "POST", body: JSON.stringify({ effort, maxTokens: options.maxTokens }) });
		return { stopReason: response.ok ? "stop" : "error" };
	} }) } as unknown as ModelRuntime;
	vi.stubGlobal("fetch", vi.fn(async (_input: unknown, init: RequestInit) => {
		const body = JSON.parse(String(init.body)); calls.push(body);
		return new Response("", { status: body.effort === undefined || ["none", "low", "high", "max"].includes(body.effort) ? 200 : 400 });
	}));
	const result = await probeThinkingInBackground(fake, model(), new AbortController().signal, 0);
	expect(result.map).toEqual({ off: "none", minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" });
	expect(calls).toHaveLength(9); expect(calls.every((call) => call.maxTokens === 64)).toBe(true);
	expect(calls[1].effort).toBe("piweb-invalid-thinking-value");
	calls.length = 0;
	vi.stubGlobal("fetch", vi.fn(async (_input: unknown, init: RequestInit) => { calls.push(JSON.parse(String(init.body))); return new Response(""); }));
	expect(await probeThinkingInBackground(fake, model(), new AbortController().signal, 0)).toEqual({ rateLimited: false });
	expect(calls).toHaveLength(2); // arbitrary values accepted: inconclusive, never promote all seven levels
});

it("applies the same effective map to SDK model getters and actual request preflight", async () => {
	await fs.writeFile(path.join(root, "models.json"), JSON.stringify({ providers: { custom: { api: "openai-completions", baseUrl: "https://models.invalid/v1", apiKey: "offline-key", models: [
		{ id: "glm-5.3-flash-background", reasoning: true }, { id: "grok/grok-4.7-build-fast@500k", reasoning: true },
	] } } }));
	const rt = await createPiWebModelRuntime({ modelsPath: path.join(root, "models.json"), authPath: path.join(root, "auth.json"), allowModelNetwork: false });
	const glm = rt.getModel("custom", "glm-5.3-flash-background")!;
	expect(getSupportedThinkingLevels(glm)).toEqual(["low", "high", "max"]);
	const grok = rt.getModel("custom", "grok/grok-4.7-build-fast@500k")!;
	expect(getSupportedThinkingLevels(grok)).toEqual(["low", "medium", "high", "xhigh"]);
	expect(rt.getModels("custom").find((m) => m.id === glm.id)).toEqual(glm);
	const available = (await rt.getAvailable()).find((m) => m.id === glm.id)!;
	expect(available).toEqual(glm);
	expect(modelThinkingMetadata(available)?.source).toBe("official");
	const network = vi.fn(async () => { throw new Error("Paid requests forbidden"); });
	let effort: unknown;
	const result = await rt.streamSimple(grok, { messages: [{ role: "user", content: "test", timestamp: Date.now() }] }, { reasoning: "max", fetch: network,
		onPayload: (payload) => { effort = (payload as Record<string, unknown>).reasoning_effort; throw new Error("OFFLINE_PAYLOAD_BUILT"); },
	}).result();
	expect(result.errorMessage).toContain("OFFLINE_PAYLOAD_BUILT");
	expect(effort).toBe("xhigh"); expect(network).not.toHaveBeenCalled();
	await rt.settleCredentialWrites();
});
