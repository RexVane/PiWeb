import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { ModelRuntime, getAgentDir } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, InMemoryModelsStore, PI_AI_VERSION, type Model, type Api } from "@earendil-works/pi-ai";
import { parse } from "jsonc-parser";
import { modelFilesFingerprint } from "./model-files";
import { replaceFileAtomically } from "./atomic-file";
import { withExternalSettingsLock } from "./settings-write-lock";
import { THINKING_LEVELS } from "./thinking-level";
import { validateThinkingLevelMap } from "./thinking-probe";
import { matchOfficialThinkingModel, thinkingApiValue, type OfficialThinkingModel, type ThinkingLevelMap } from "./thinking-config";
import { registerShutdownHook } from "./graceful-shutdown";

type ChatModel = Model<Api>;
export interface ThinkingMetadata {
	source: "custom" | "official" | "probe" | "default";
	status: "none" | "queued" | "probing" | "cached" | "failed";
	officialModel?: string;
}
interface CacheEntry { map?: ThinkingLevelMap; expiresAt: number; status: "cached" | "failed" }
export interface BackgroundProbeResult { map?: ThinkingLevelMap; rateLimited?: boolean }
export type BackgroundProbe = (runtime: ModelRuntime, model: ChatModel, signal: AbortSignal) => Promise<BackgroundProbeResult>;
const metadata = new WeakMap<object, ThinkingMetadata>();
export const modelThinkingMetadata = (model: object): ThinkingMetadata | undefined => metadata.get(model);
const listeners = new Set<(provider: string, id: string) => void>();
export function onThinkingCapabilitiesChanged(listener: (provider: string, id: string) => void): () => void {
	listeners.add(listener); return () => { listeners.delete(listener); };
}
const notify = (model: ChatModel) => { for (const listener of listeners) { try { listener(model.provider, model.id); } catch { /* a consumer cannot break the queue */ } } };
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const CACHE_LIMIT = 256;
const CACHE_BYTES = 1024 * 1024;
const SUCCESS_TTL = 7 * 24 * 60 * 60 * 1000;
const FAILURE_TTL = 60 * 60 * 1000;
let catalogPromise: Promise<OfficialThinkingModel[]> | null = null;
async function officialCatalog(): Promise<OfficialThinkingModel[]> {
	catalogPromise ??= ModelRuntime.create({ modelsPath: null, refreshOnCreate: false, allowModelNetwork: false,
		credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(),
	}).then((runtime) => runtime.getModels().map((model) => ({ provider: model.provider, id: model.id, reasoning: model.reasoning,
		...(model.thinkingLevelMap ? { thinkingLevelMap: validateThinkingLevelMap(model.thinkingLevelMap) ?? undefined } : {}),
	}))).catch((error) => { catalogPromise = null; throw error; });
	return catalogPromise;
}

/** Never execute !credential/header commands or refresh OAuth solely to discover levels. */
async function safeToProbe(runtime: ModelRuntime, model: ChatModel, agentDir: string): Promise<boolean> {
	if (model.api === "openai-responses" && (model.compat as Record<string, unknown> | undefined)?.supportsMaxOutputTokens === false) return false;
	if (!runtime.hasConfiguredAuth(model.provider) || runtime.getRegisteredProviderIds().includes(model.provider)) return false;
	const read = async (name: string) => {
		try { const file = path.join(agentDir, name); if ((await fs.stat(file)).size > 2 * 1024 * 1024) return null; return parse(await fs.readFile(file, "utf8")); }
		catch { return null; }
	};
	const config = await read("models.json");
	const provider = config?.providers?.[model.provider];
	if (!record(provider)) return false;
	const credential = (await read("auth.json"))?.[model.provider];
	if (credential?.type === "oauth") return false;
	const command = (value: unknown) => typeof value === "string" && value.trimStart().startsWith("!");
	if (command(credential?.key)) return false;
	const declared = Array.isArray(provider.models) ? provider.models.filter((entry) => record(entry) && entry.id === model.id) : [];
	const override = record(provider.modelOverrides) ? provider.modelOverrides[model.id] : undefined;
	return ![provider, ...declared, override, model].some((entry) => record(entry) &&
		(command(entry.apiKey) || Object.values(record(entry.headers) ? entry.headers : {}).some(command)));
}

/** Protocol-aware, small synthetic requests through the same SDK/auth/compat path as a real chat.
 * A negative control must be rejected before HTTP acceptance can become a cached level map.
 * This verifies request acceptance, not the model's actual reasoning effort or upstream identity.
 */
export async function probeThinkingInBackground(runtime: ModelRuntime, model: ChatModel, signal: AbortSignal, paceMs = 3500, isCurrent = () => true): Promise<BackgroundProbeResult> {
	const request = async (candidate: ChatModel, level?: string) => {
		signal.throwIfAborted();
		if (!isCurrent()) throw new Error("Model configuration changed during thinking probe");
		let status = 0;
		const syntheticModel = { ...candidate, samplingParams: undefined, samplingParamsByThinkingLevel: undefined };
		const stream = runtime.streamSimple(syntheticModel, { messages: [{ role: "user", content: "Reply with OK.", timestamp: Date.now() }] }, {
			apiKey: undefined, maxTokens: 64, maxRetries: 0, signal,
			onPayload: (payload) => {
				const body = payload as Record<string, unknown>;
				for (const field of ["max_tokens", "max_completion_tokens", "max_output_tokens"]) if (field in body) body[field] = 64;
			},
			...(level ? { reasoning: level as never } : {}),
			fetch: async (input, init) => {
				if (!isCurrent()) throw new Error("Model configuration changed during thinking probe");
				const response = await fetch(input, { ...init, redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) });
				status = response.status; return response;
			},
		});
		const result = await stream.result();
		return { status, ok: status >= 200 && status < 300 && result.stopReason !== "error" && result.stopReason !== "aborted" };
	};
	const wait = () => new Promise<void>((resolve, reject) => {
		if (signal.aborted) { reject(signal.reason); return; }
		const abort = () => { clearTimeout(timer); reject(signal.reason); };
		const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, paceMs);
		signal.addEventListener("abort", abort, { once: true });
	});
	const baseline = await request({ ...model, reasoning: false, thinkingLevelMap: undefined });
	if (!baseline.ok) return { rateLimited: baseline.status === 429 };
	await wait();
	const negative = await request({ ...model, reasoning: true, thinkingLevelMap: { low: "piweb-invalid-thinking-value" } }, "low");
	if (negative.status !== 400 && negative.status !== 422) return { rateLimited: negative.status === 429 };
	const identity = Object.fromEntries(THINKING_LEVELS.map((level) => [level, thinkingApiValue(level)]));
	const map: ThinkingLevelMap = {};
	for (const level of THINKING_LEVELS) {
		await wait();
		const result = await request({ ...model, reasoning: true, thinkingLevelMap: identity }, level);
		if (result.ok) map[level] = thinkingApiValue(level);
		else if (result.status === 400 || result.status === 422) map[level] = null;
		else return { rateLimited: result.status === 429 }; // timeouts/auth/5xx are not unsupported levels
	}
	return Object.values(map).some((value) => value !== null) ? { map } : {};
}

export interface ThinkingPolicyOptions {
	allowBackground?: boolean;
	probe?: BackgroundProbe;
	now?: () => number;
	onChange?: (model: ChatModel) => void;
}
export class ThinkingPolicy {
	private cache = new Map<string, CacheEntry>();
	private pending = new Map<string, "queued" | "probing">();
	private copies = new WeakMap<ChatModel, { signature: string; model: ChatModel }>();
	private origins = new WeakMap<ChatModel, ChatModel>();
	private queue: Array<{ key: string; model: ChatModel; runtime: ModelRuntime; revision: string }> = [];
	private cooldown = new Map<string, number>();
	private running: Promise<void> | null = null;
	private controller = new AbortController();
	private writable = true;
	private now: () => number;
	private exact: Map<string, OfficialThinkingModel>;
	readonly file: string;
	constructor(private catalog: readonly OfficialThinkingModel[], private agentDir: string, private options: ThinkingPolicyOptions = {}) {
		this.now = options.now ?? Date.now;
		this.exact = new Map(catalog.map((model) => [JSON.stringify([model.provider, model.id]), model]));
		this.file = path.join(agentDir, "web-thinking-cache.json");
	}
	async load(): Promise<void> {
		try {
			if ((await fs.stat(this.file)).size > CACHE_BYTES) { this.writable = false; return; }
			const data = JSON.parse(await fs.readFile(this.file, "utf8"));
			if (data.version !== 1 || !record(data.entries)) { this.writable = false; return; }
			for (const [key, value] of Object.entries(data.entries).slice(0, CACHE_LIMIT)) {
				if (!/^[a-f0-9]{64}$/.test(key) || !record(value) || !Number.isFinite(value.expiresAt) || Number(value.expiresAt) <= this.now()) continue;
				const map = value.map === undefined ? undefined : validateThinkingLevelMap(value.map);
				if (map === null || !["cached", "failed"].includes(String(value.status))) continue;
				this.cache.set(key, { expiresAt: Number(value.expiresAt), status: value.status as CacheEntry["status"], ...(map ? { map } : {}) });
			}
		} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.writable = false; }
	}
	resolve(model: ChatModel, runtime: ModelRuntime): ChatModel {
		model = this.origins.get(model) ?? model;
		const native = this.exact.get(JSON.stringify([model.provider, model.id]));
		if (!model.reasoning || model.thinkingLevelMap !== undefined) {
			const unchangedOfficial = native && native.reasoning === model.reasoning && THINKING_LEVELS.every((level) => native.thinkingLevelMap?.[level] === model.thinkingLevelMap?.[level as keyof typeof model.thinkingLevelMap]);
			metadata.set(model, { source: unchangedOfficial ? "official" : model.thinkingLevelMap !== undefined ? "custom" : "default", status: "none" }); return model;
		}
		if (runtime.getRegisteredProviderIds().includes(model.provider)) {
			metadata.set(model, { source: "default", status: "none" }); return model; // extension-owned model policy stays with its extension
		}
		const official = native ?? matchOfficialThinkingModel(model, this.catalog);
		let map = official?.thinkingLevelMap;
		let info: ThinkingMetadata = { source: official ? "official" : "default", status: "none", ...(official ? { officialModel: `${official.provider}/${official.id}` } : {}) };
		if (!official) {
			const revision = modelFilesFingerprint(this.agentDir);
			const key = createHash("sha256").update(JSON.stringify([PI_AI_VERSION, this.agentDir, model.provider, model.id, model.api, model.baseUrl,
				model.compat, model.headers, revision])).digest("hex");
			const saved = this.cache.get(key);
			if (saved && saved.expiresAt > this.now()) {
				map = saved.map; info = { source: map ? "probe" : "default", status: saved.status };
			} else {
				const enabled = this.options.allowBackground ?? (process.env.NODE_ENV !== "test" && !/^(1|true|yes)$/i.test(process.env.PI_OFFLINE ?? "") && ! /^(0|false|off|no)$/i.test(process.env.PIWEB_AUTO_THINKING_PROBE ?? "") && process.env.NEXT_PHASE !== "phase-production-build");
				if (enabled && !this.controller.signal.aborted && ["openai-completions", "openai-responses"].includes(model.api)
					&& runtime.hasConfiguredAuth(model.provider) && !this.pending.has(key) && this.queue.length < 32) {
					this.pending.set(key, "queued"); this.queue.push({ key, model, runtime, revision });
					this.kick();
				}
				info.status = this.pending.get(key) ?? "none";
			}
		}
		const signature = JSON.stringify([map, info]);
		const previous = this.copies.get(model);
		if (previous?.signature === signature) return previous.model;
		const effective = map ? { ...model, thinkingLevelMap: { ...map } } : { ...model };
		metadata.set(effective, info); this.origins.set(effective, model); this.copies.set(model, { signature, model: effective }); return effective;
	}
	private kick(): void {
		if (this.running || this.controller.signal.aborted) return;
		this.running = Promise.resolve().then(() => this.drain()).finally(() => { this.running = null; if (this.queue.length) this.kick(); });
	}
	private async drain(): Promise<void> {
		while (this.queue.length && !this.controller.signal.aborted) {
			const job = this.queue.shift()!;
			const current = () => modelFilesFingerprint(this.agentDir) === job.revision;
			if (!current()) { this.pending.delete(job.key); continue; }
			this.pending.set(job.key, "probing");
			let result: BackgroundProbeResult = {};
			try {
				if ((this.cooldown.get(job.model.provider) ?? 0) <= this.now() && (this.options.probe || await safeToProbe(job.runtime, job.model, this.agentDir))) {
					const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(180_000)]);
					result = this.options.probe ? await this.options.probe(job.runtime, job.model, signal)
						: await probeThinkingInBackground(job.runtime, job.model, signal, 3500, current);
				}
			} catch { /* failed probes leave official/SDK fallbacks intact */ }
			if (this.controller.signal.aborted) break;
			if (result.rateLimited) this.cooldown.set(job.model.provider, this.now() + FAILURE_TTL);
			const candidate = result.map && validateThinkingLevelMap(result.map);
			const map = candidate && Object.values(candidate).some((value) => value !== null) ? candidate : undefined;
			this.cache.set(job.key, { ...(map ? { map } : {}), status: map ? "cached" : "failed", expiresAt: this.now() + (map ? SUCCESS_TTL : FAILURE_TTL) });
			this.pending.delete(job.key);
			while (this.cache.size > CACHE_LIMIT) this.cache.delete(this.cache.keys().next().value!);
			await this.save();
			(this.options.onChange ?? notify)(job.model);
		}
	}
	private async save(): Promise<void> {
		if (!this.writable) return;
		const temporary = `${this.file}.${randomUUID()}.tmp`;
		try {
			await withExternalSettingsLock(this.file, async () => {
				// Cooperating processes may have cached different models since our initial load.
				const merged = new Map<string, CacheEntry>();
				try {
					if ((await fs.stat(this.file)).size > CACHE_BYTES) throw new Error("Invalid thinking cache");
					const saved = JSON.parse(await fs.readFile(this.file, "utf8"));
					if (saved.version !== 1 || !record(saved.entries)) throw new Error("Invalid thinking cache");
					for (const [key, value] of Object.entries(saved.entries)) {
						if (!/^[a-f0-9]{64}$/.test(key) || !record(value) || Number(value.expiresAt) <= this.now() || !Number.isFinite(value.expiresAt)) continue;
						const map = value.map === undefined ? undefined : validateThinkingLevelMap(value.map);
						if (map === null || !["cached", "failed"].includes(String(value.status))) continue;
						merged.set(key, { expiresAt: Number(value.expiresAt), status: value.status as CacheEntry["status"], ...(map ? { map } : {}) });
					}
				} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
				for (const [key, value] of this.cache) if (value.expiresAt > this.now()) merged.set(key, value);
				while (merged.size > CACHE_LIMIT) merged.delete(merged.keys().next().value!);
				this.cache = merged;
				await fs.writeFile(temporary, JSON.stringify({ version: 1, entries: Object.fromEntries(merged) }), { flag: "wx", mode: 0o600 });
				await replaceFileAtomically(temporary, this.file);
			});
		} catch { /* a derived cache write cannot block model selection */ }
		finally { await fs.unlink(temporary).catch(() => undefined); }
	}
	async settle(): Promise<void> { while (this.running) await this.running; }
	stop(): void { this.controller.abort(); this.queue = []; this.pending.clear(); }
}

const policies = new Map<string, Promise<ThinkingPolicy>>();
export async function attachThinkingPolicy(runtime: ModelRuntime, agentDir = getAgentDir()): Promise<void> {
	const root = path.resolve(agentDir);
	let policy = policies.get(root);
	if (!policy) {
		policy = officialCatalog().then(async (catalog) => { const service = new ThinkingPolicy(catalog, root); await service.load(); return service; });
		policies.set(root, policy);
		if (policies.size > 32) policies.delete(policies.keys().next().value!);
	}
	const service = await policy;
	const apply = (model: ChatModel) => service.resolve(model, runtime);
	const getModel = runtime.getModel.bind(runtime);
	const getModels = runtime.getModels.bind(runtime);
	const available = runtime.getAvailableSnapshot.bind(runtime);
	const getAvailable = runtime.getAvailable.bind(runtime);
	const physical = runtime.getPhysicalModel.bind(runtime);
	const streamSimple = runtime.streamSimple.bind(runtime);
	runtime.streamSimple = (model, context, options) => streamSimple(apply(model), context, options);
	runtime.getModel = (provider, id) => { const model = getModel(provider, id); return model && apply(model); };
	runtime.getModels = (provider) => getModels(provider).map(apply);
	runtime.getAvailableSnapshot = () => available().map(apply);
	runtime.getAvailable = async (...args) => (await getAvailable(...args)).map(apply);
	runtime.getPhysicalModel = (provider, id) => { const model = physical(provider, id); return model && apply(model); };
	if (process.env.NODE_ENV !== "test") registerShutdownHook(() => { service.stop(); return service.settle(); }, { name: "thinking-probes" });
}
