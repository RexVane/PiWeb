/**
 * models-service：pi 模型目录 / 认证状态 / API key 管理 / 自定义 provider（models.json）。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getAgentDir, getModelRuntime, resetModelRuntime } from "./pi";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";

export interface ModelView {
	provider: string;
	id: string;
	name: string;
	api: string;
	baseUrl?: string;
	reasoning: boolean;
	thinkingLevels: string[];
	contextWindow: number;
	input: string[];
	cost: { input: number; output: number } | null;
}

export interface ProviderView {
	id: string;
	name: string;
	baseUrl?: string;
	apiKeyLabel?: string;
	authTypes: Array<"api_key" | "oauth">;
	apis: string[];
	builtIn: boolean;
	authConfigured: boolean;
	authSource?: string;
	authReady: boolean;
	authFastPath: boolean;
	resolvedAuthSource?: string;
	authError?: string;
	keyManaged: boolean;
	modelCount: number;
}

export interface DiscoveredModel {
	id: string;
	name?: string;
}

let builtInProviderIdsPromise: Promise<Set<string>> | null = null;

/** 目录短缓存：页面挂载与设置关闭都会拉一次；认证探测（每个供应商一次网络往返）不必秒级重复 */
let listCache: { at: number; value: Promise<{ providers: ProviderView[]; models: ModelView[] }> } | null = null;
const LIST_TTL_MS = 5_000;

export function invalidateModelList(): void {
	listCache = null;
}

/** Read the unmodified SDK catalog through its public modelsPath:null option. */
function getBuiltInProviderIds(): Promise<Set<string>> {
	if (!builtInProviderIdsPromise) {
		builtInProviderIdsPromise = ModelRuntime.create({ modelsPath: null, refreshOnCreate: false })
			.then((runtime) => new Set(runtime.getProviders().map((provider) => provider.id)))
			.catch((error) => {
				builtInProviderIdsPromise = null;
				throw error;
			});
	}
	return builtInProviderIdsPromise;
}

function envKeyOf(providerId: string): string | null {
	void providerId;
	return null;
}

export function listModels(): Promise<{
	providers: ProviderView[];
	models: ModelView[];
}> {
	if (listCache && Date.now() - listCache.at < LIST_TTL_MS) return listCache.value;
	const value = listModelsUncached().catch((error) => {
		listCache = null;
		throw error;
	});
	listCache = { at: Date.now(), value };
	return value;
}

async function listModelsUncached(): Promise<{
	providers: ProviderView[];
	models: ModelView[];
}> {
	const rt = await getModelRuntime();
	const builtInProviderIds = await getBuiltInProviderIds();
	const providers = rt.getProviders() as any[];
	const out: ProviderView[] = [];
	const models: ModelView[] = [];
	// 认证探测逐个 await 时，N 个已配置供应商就是 N 次串行网络往返；并发做，单个超时不拖累整体
	const checks = await Promise.all(
		providers.map(async (p) => {
			const pid = String(p.id ?? p.name ?? "");
			if (!pid) return null;
			let auth: any = null;
			try {
				auth = rt.getProviderAuthStatus(pid);
			} catch {
				auth = null;
			}
			const authFastPath = rt.hasConfiguredAuth(pid);
			let authReady = false;
			let resolvedAuthSource: string | undefined;
			let authError: string | undefined;
			if (auth?.configured === true || authFastPath) {
				try {
					const checked = await rt.checkAuth(pid, { signal: AbortSignal.timeout(5000) });
					authReady = checked !== undefined;
					resolvedAuthSource = checked?.source;
				} catch (error) {
					authError = error instanceof Error ? error.message : String(error);
				}
			}
			return { pid, p, auth, authFastPath, authReady, resolvedAuthSource, authError };
		}),
	);
	for (const c of checks) {
		if (!c) continue;
		const { pid, p, auth, authFastPath, authReady, resolvedAuthSource, authError } = c;
		const list = rt.getModels(pid) as any[];
		const authTypes: Array<"api_key" | "oauth"> = [];
		if (p.auth?.apiKey) authTypes.push("api_key");
		if (p.auth?.oauth) authTypes.push("oauth");
		out.push({
			id: pid,
			name: String(p.name ?? pid),
			baseUrl: typeof p.baseUrl === "string" ? p.baseUrl : undefined,
			apiKeyLabel: typeof p.auth?.apiKey?.name === "string" ? p.auth.apiKey.name : undefined,
			authTypes,
			apis: [...new Set(list.map((mm) => String(mm.api ?? "")).filter(Boolean))].sort(),
			builtIn: builtInProviderIds.has(pid),
			authConfigured: auth?.configured === true,
			authSource: auth?.source,
			authReady,
			authFastPath,
			resolvedAuthSource,
			authError,
			keyManaged: auth?.source === "stored",
			modelCount: list.length,
		});
		for (const mm of list) {
			models.push({
				provider: pid,
				id: String(mm.id),
				name: String(mm.name ?? mm.id),
				api: String(mm.api ?? ""),
				baseUrl: typeof mm.baseUrl === "string" ? mm.baseUrl : undefined,
				reasoning: mm.reasoning === true,
				thinkingLevels: getSupportedThinkingLevels(mm),
				contextWindow: Number(mm.contextWindow ?? 0),
				input: Array.isArray(mm.input) ? mm.input.map(String) : ["text"],
				cost: mm.cost ? { input: mm.cost.input, output: mm.cost.output } : null,
			});
		}
	}
	models.sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id));
	return { providers: out, models };
}

/**
 * 录入 / 更新 API key（写 ~/.pi/agent/auth.json，与终端 pi 共享）。
 * 部分-provider 登录不止一步（Vertex/Bedrock 先选认证方式，Cloudflare 还要
 * account/gateway ID）：首个文本提示用调用方给的 key 应答，其余提示经
 * pendingLogin 桥接到浏览器轮询（loginState/answerLogin/cancelLogin）。
 */
export async function setApiKey(providerId: string, apiKey: string): Promise<void> {
	const rt = await getModelRuntime();
	purgeFinishedLogins();
	const prev = pendingLogins.get(providerId);
	if (prev && !prev.done) prev.rejecter?.(new Error("canceled"));
	const pl: PendingLogin = { providerId, prompt: null, resolver: null, rejecter: null, notifyLog: [], done: false };
	pendingLogins.set(providerId, pl);
	let firstTextAnswered = false;
	try {
		await rt.login(providerId, "api_key", {
			prompt: async (p: any) => {
				if (!firstTextAnswered && !(Array.isArray(p?.options) && p.options.length)) {
					firstTextAnswered = true;
					return apiKey;
				}
				pl.prompt = p;
				const answer = await new Promise<string>((resolve, reject) => {
					pl.resolver = resolve;
					pl.rejecter = reject;
				});
				pl.prompt = null;
				return answer;
			},
			notify: (e: any) => {
				pl.notifyLog.push(typeof e === "string" ? e : JSON.stringify(e));
				if (pl.notifyLog.length > 20) pl.notifyLog.shift();
			},
		} as never);
		pl.done = true;
		pl.prompt = null;
		pl.finishedAt = Date.now();
		invalidateModelList();
	} catch (error) {
		pl.done = true;
		pl.error = String((error as any)?.message ?? error);
		pl.prompt = null;
		pl.finishedAt = Date.now();
		throw error;
	}
}

export async function removeApiKey(providerId: string): Promise<void> {
	const rt = await getModelRuntime();
	await rt.logout(providerId);
	invalidateModelList();
}

/** 已存密钥回退：编辑表单的 key 框为空（「留空保持不变」）时，从这里取。 */
async function storedApiKeyFor(providerId: string): Promise<string | undefined> {
	// 自定义 provider / 内置覆盖层：models.json providers[id].apiKey
	try {
		const parsed = JSON.parse(await fs.readFile(modelsJsonPath(), "utf8")) as CustomProvidersFile;
		const key = (parsed.providers as Record<string, any> | undefined)?.[providerId]?.apiKey;
		if (typeof key === "string" && key.trim()) return key.trim();
	} catch {
		/* 读取失败按无已存密钥处理 */
	}
	// 内置 provider：setKey（rt.login api_key）写入的 auth.json 条目
	try {
		const parsed = JSON.parse(await fs.readFile(path.join(getAgentDir(), "auth.json"), "utf8")) as Record<string, any>;
		const entry = parsed?.[providerId] ?? parsed?.providers?.[providerId];
		const key = entry?.apiKey ?? entry?.api_key ?? entry?.key;
		if (typeof key === "string" && key.trim()) return key.trim();
	} catch {
		/* 同上 */
	}
	return undefined;
}

/** Fetch a provider's conventional /models catalog without persisting credentials. */
export async function discoverModels(input: { baseUrl: string; api?: string; apiKey?: string; providerId?: string }): Promise<DiscoveredModel[]> {
	const rawBaseUrl = input.baseUrl.trim();
	if (!rawBaseUrl) throw new Error("缺少 API 地址");
	const base = new URL(rawBaseUrl);
	if (base.protocol !== "http:" && base.protocol !== "https:") throw new Error("API 地址必须使用 http 或 https");
	if (!base.pathname.replace(/\/+$/, "").endsWith("/models")) {
		base.pathname = `${base.pathname.replace(/\/+$/, "")}/models`;
	}
	const headers: Record<string, string> = { Accept: "application/json" };
	// 表单 key 为空时回退到该 provider 的已存密钥（编辑场景：占位符「留空保持不变」）
	const apiKey = input.apiKey?.trim() || (input.providerId ? await storedApiKeyFor(input.providerId) : undefined);
	if (apiKey) {
		if (input.api === "anthropic-messages") headers["x-api-key"] = apiKey;
		else headers.Authorization = `Bearer ${apiKey}`;
	}
	if (input.api === "anthropic-messages") headers["anthropic-version"] = "2023-06-01";
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 15000);
	try {
		const response = await fetch(base, { headers, signal: controller.signal });
		if (!response.ok) throw new Error(`模型目录请求失败（HTTP ${response.status}）`);
		const payload = (await response.json()) as unknown;
		const candidates = Array.isArray(payload)
			? payload
			: payload && typeof payload === "object"
				? Array.isArray((payload as { data?: unknown }).data)
					? (payload as { data: unknown[] }).data
					: Array.isArray((payload as { models?: unknown }).models)
						? (payload as { models: unknown[] }).models
						: []
				: [];
		const models = candidates
			.map((candidate): DiscoveredModel | null => {
				if (typeof candidate === "string") return { id: candidate };
				if (!candidate || typeof candidate !== "object") return null;
				const value = candidate as Record<string, unknown>;
				const id = typeof value.id === "string" ? value.id.trim() : "";
				if (!id) return null;
				const name = typeof value.name === "string" && value.name.trim() ? value.name.trim() : undefined;
				return { id, ...(name ? { name } : {}) };
			})
			.filter((model): model is DiscoveredModel => Boolean(model))
			.filter((model, index, all) => all.findIndex((item) => item.id === model.id) === index)
			.slice(0, 500);
		if (!models.length) throw new Error("响应中没有可识别的模型 ID");
		return models;
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError") throw new Error("模型目录请求超时");
		if (error instanceof TypeError && error.message.toLowerCase().includes("fetch")) throw new Error("无法连接模型目录，请检查 API 地址和网络");
		throw error;
	} finally {
		clearTimeout(timeout);
	}
}

// ---------- OAuth 订阅登录（Claude/Codex/Copilot 等） ----------

interface PendingLogin {
	providerId: string;
	prompt: any | null;
	resolver: ((value: string) => void) | null;
	rejecter: ((err: Error) => void) | null;
	notifyLog: string[];
	done: boolean;
	error?: string;
	finishedAt?: number;
}

const pendingLogins = new Map<string, PendingLogin>();

/** 清理已完成且超过 10 分钟的登录条目，避免长期运行内存缓慢增长。 */
function purgeFinishedLogins(): void {
	const now = Date.now();
	for (const [id, pl] of pendingLogins) {
		if (pl.done && pl.finishedAt !== undefined && now - pl.finishedAt > 10 * 60_000) pendingLogins.delete(id);
	}
}

/** 启动 OAuth 登录（后台运行，交互经 pendingLogin 桥接到浏览器轮询） */
export async function startLogin(providerId: string): Promise<void> {
	purgeFinishedLogins();
	// 已有同 provider 流程则先取消
	const prev = pendingLogins.get(providerId);
	if (prev && !prev.done) prev.rejecter?.(new Error("canceled"));
	const pl: PendingLogin = { providerId, prompt: null, resolver: null, rejecter: null, notifyLog: [], done: false };
	pendingLogins.set(providerId, pl);
	let rt;
	try {
		rt = await getModelRuntime();
	} catch (error) {
		// 运行时初始化失败也要给轮询方一个终态，否则条目永远卡在进行中。
		pl.done = true;
		pl.error = String((error as any)?.message ?? error);
		pl.finishedAt = Date.now();
		throw error;
	}
	void rt
		.login(providerId, "oauth", {
			prompt: async (p: any) => {
				pl.prompt = p;
				const answer = await new Promise<string>((resolve, reject) => {
					pl.resolver = resolve;
					pl.rejecter = reject;
				});
				pl.prompt = null;
				return answer;
			},
			notify: (e: any) => {
				pl.notifyLog.push(typeof e === "string" ? e : JSON.stringify(e));
				if (pl.notifyLog.length > 20) pl.notifyLog.shift();
			},
		} as never)
		.then(() => {
			pl.done = true;
			pl.prompt = null;
			pl.finishedAt = Date.now();
			invalidateModelList();
		})
		.catch((err: any) => {
			pl.done = true;
			pl.error = String(err?.message ?? err);
			pl.prompt = null;
			pl.finishedAt = Date.now();
		});
}

export function loginState(providerId: string): {
	prompt: { type: string; message: string; placeholder?: string; options?: string[] } | null;
	notifyLog: string[];
	done: boolean;
	error?: string;
} {
	purgeFinishedLogins();
	const pl = pendingLogins.get(providerId);
	if (!pl) return { prompt: null, notifyLog: [], done: true };
	return {
		prompt: pl.prompt
			? {
					type: String(pl.prompt.type ?? "text"),
					message: String(pl.prompt.message ?? ""),
					placeholder: pl.prompt.placeholder ? String(pl.prompt.placeholder) : undefined,
					options: Array.isArray(pl.prompt.options) ? pl.prompt.options.map((o: any) => String(o.label ?? o.value ?? o)) : undefined,
				}
			: null,
		notifyLog: [...pl.notifyLog],
		done: pl.done,
		error: pl.error,
	};
}

export function answerLogin(providerId: string, text: string): boolean {
	const pl = pendingLogins.get(providerId);
	if (!pl?.resolver) return false;
	pl.resolver(text);
	return true;
}

export function cancelLogin(providerId: string): boolean {
	purgeFinishedLogins();
	const pl = pendingLogins.get(providerId);
	if (!pl) return false;
	if (pl.done) return true;
	if (pl.rejecter) {
		pl.rejecter(new Error("canceled"));
		return true;
	}
	// prompt 未挂起（正在等待浏览器 OAuth 回调）：SDK 没有中断手段，
	// 只能标记为已取消让前端停止轮询；后台流程若最终成功仍会写入凭证。
	pl.done = true;
	pl.error = "canceled";
	pl.prompt = null;
	pl.finishedAt = Date.now();
	return true;
}

// ---------- 自定义 provider（~/.pi/agent/models.json） ----------

function modelsJsonPath(): string {
	return path.join(getAgentDir(), "models.json");
}

interface CustomProvidersFile {
	providers?: Record<string, unknown>;
}

export function redactCustomProviderSecrets(content: string): { content: string; secretProviderIds: string[] } {
	const parsed = JSON.parse(content) as CustomProvidersFile;
	const secretProviderIds: string[] = [];
	for (const [id, value] of Object.entries(parsed.providers ?? {})) {
		if (!value || typeof value !== "object" || Array.isArray(value)) continue;
		const provider = value as Record<string, unknown>;
		if (!Object.prototype.hasOwnProperty.call(provider, "apiKey")) continue;
		delete provider.apiKey;
		secretProviderIds.push(id);
	}
	return { content: JSON.stringify(parsed, null, 2), secretProviderIds };
}

export function preserveCustomProviderApiKeys(content: string, previousContent: string): string {
	const parsed = JSON.parse(content) as CustomProvidersFile;
	const previous = JSON.parse(previousContent) as CustomProvidersFile;
	for (const [id, value] of Object.entries(parsed.providers ?? {})) {
		if (!value || typeof value !== "object" || Array.isArray(value)) continue;
		const provider = value as Record<string, unknown>;
		// 读取时会脱敏删除 apiKey，因此「字段缺失」意味着保留旧密钥；
		// 显式写 "apiKey": null 是唯一的删除途径，不能被旧密钥复活。
		if (provider.apiKey === null) {
			delete provider.apiKey;
			continue;
		}
		const previousProvider = previous.providers?.[id];
		if (
			!Object.prototype.hasOwnProperty.call(provider, "apiKey")
			&& previousProvider
			&& typeof previousProvider === "object"
			&& !Array.isArray(previousProvider)
			&& Object.prototype.hasOwnProperty.call(previousProvider, "apiKey")
		) {
			provider.apiKey = (previousProvider as Record<string, unknown>).apiKey;
		}
	}
	return JSON.stringify(parsed, null, 2);
}

export async function readCustomProviders(): Promise<{ content: string; exists: boolean; secretProviderIds: string[] }> {
	try {
		return { ...redactCustomProviderSecrets(await fs.readFile(modelsJsonPath(), "utf8")), exists: true };
	} catch {
		return { content: JSON.stringify({ providers: {} }, null, 2), exists: false, secretProviderIds: [] };
	}
}

export async function writeCustomProviders(content: string): Promise<void> {
	let mergedContent = content;
	try {
		mergedContent = preserveCustomProviderApiKeys(content, await fs.readFile(modelsJsonPath(), "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			// Invalid incoming JSON is reported by the canonical parse below.
			JSON.parse(content);
		}
	}
	const parsed = JSON.parse(mergedContent) as CustomProvidersFile;
	if (!parsed || typeof parsed !== "object" || typeof parsed.providers !== "object" || parsed.providers === null) {
		throw new Error('models.json 顶层必须是 { "providers": { ... } }');
	}
	const builtInProviderIds = await getBuiltInProviderIds();
	for (const [id, p] of Object.entries(parsed.providers)) {
		if (!p || typeof p !== "object" || Array.isArray(p)) throw new Error(`provider "${id}" 必须是对象`);
		const provider = p as Record<string, unknown>;
		const builtIn = builtInProviderIds.has(id);
		if (provider.baseUrl !== undefined && (typeof provider.baseUrl !== "string" || !provider.baseUrl.trim())) {
			throw new Error(`provider "${id}" 的 baseUrl 必须是非空字符串`);
		}
		if (provider.api !== undefined && (typeof provider.api !== "string" || !provider.api.trim())) {
			throw new Error(`provider "${id}" 的 api 必须是非空字符串`);
		}
		if (provider.models !== undefined) {
			if (!Array.isArray(provider.models)) throw new Error(`provider "${id}" 的 models 必须是数组`);
			for (const model of provider.models) {
				if (!model || typeof model !== "object" || typeof (model as Record<string, unknown>).id !== "string" || !(model as { id: string }).id.trim()) {
					throw new Error(`provider "${id}" 包含无效模型 ID`);
				}
				const entry = model as Record<string, unknown>;
				// 可选容量覆盖（前端 K/M 写法在此前已换算为整数）
				for (const field of ["contextWindow", "maxTokens"] as const) {
					if (entry[field] === undefined) continue;
					if (typeof entry[field] !== "number" || !Number.isFinite(entry[field] as number) || (entry[field] as number) <= 0) {
						throw new Error(`provider "${id}" 模型 "${entry.id}" 的 ${field} 必须是正整数`);
					}
				}
			}
		}
		if (!builtIn) {
			if (typeof provider.baseUrl !== "string" || !provider.baseUrl.trim()) throw new Error(`provider "${id}" 缺少 baseUrl`);
			if (typeof provider.api !== "string" || !provider.api.trim()) throw new Error(`provider "${id}" 缺少 api`);
			if (!Array.isArray(provider.models) || provider.models.length === 0) throw new Error(`provider "${id}" 至少需要一个模型`);
		}
	}
	await fs.writeFile(modelsJsonPath(), JSON.stringify(parsed, null, 2), "utf8");
	resetModelRuntime();
	invalidateModelList();
}
