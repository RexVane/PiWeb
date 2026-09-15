/**
 * models-service：pi 模型目录 / 认证状态 / API key 管理 / 自定义 provider（models.json）。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import dns from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getNodeValue, parseTree, printParseErrorCode, type ParseError } from "jsonc-parser";
import { getAgentDir, getModelRuntime, resetModelRuntime } from "./pi";
import { reloadSessionsForCwd } from "./agent-manager";
import {
	getSupportedThinkingLevels, InMemoryCredentialStore, InMemoryModelsStore,
	type AuthInteraction, type AuthPrompt, type AuthType,
} from "@earendil-works/pi-ai";
import { withExternalSettingsLock, withSettingsWriteLock } from "./settings-write-lock";
import { MONTHLY_WINDOW_SECONDS, WEEKLY_WINDOW_SECONDS, type BalanceAmount, type BalanceDetailKey, type BalanceUsage, type ProviderUsage, type QuotaUsage, type QuotaWindow, type XaiUsage } from "./provider-usage";
// 用量的纯类型/纯函数拆在 provider-usage（客户端安全：设置面板按值导入它们）；这里重导出，路由与测试的导入不变。
export { MONTHLY_WINDOW_SECONDS, WEEKLY_WINDOW_SECONDS, quotaWindowKind, supportsUsageProbe } from "./provider-usage";
export type { BalanceAmount, BalanceDetailKey, BalanceUsage, ProviderUsage, QuotaUsage, QuotaWindow, QuotaWindowKind, XaiUsage } from "./provider-usage";
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
	/** auth.json 里已存凭证的类型：OAuth 条目才有专门的删除入口与文案 */
	storedAuthType?: "api_key" | "oauth";
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
		builtInProviderIdsPromise = ModelRuntime.create({
			modelsPath: null, refreshOnCreate: false, allowModelNetwork: false,
			credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(),
		})
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

/** auth.json 各条目的凭证类型（与 storedCredentialFor 同样的两层数据结构）；读取失败不影响目录 */
async function readStoredAuthTypes(): Promise<Map<string, "api_key" | "oauth">> {
	const out = new Map<string, "api_key" | "oauth">();
	try {
		const parsed = JSON.parse(await fs.readFile(path.join(getAgentDir(), "auth.json"), "utf8")) as Record<string, any>;
		const entries: Array<[string, any]> = [
			...Object.entries(parsed ?? {}),
			...Object.entries(parsed?.providers ?? {}),
		];
		for (const [id, entry] of entries) {
			if (out.has(id)) continue;
			if (entry?.type === "oauth") out.set(id, "oauth");
			else if (entry && typeof entry === "object" && [entry.apiKey, entry.api_key, entry.key].some((v) => typeof v === "string" && v.trim())) out.set(id, "api_key");
		}
	} catch {
		/* missing or malformed auth.json: no stored credentials to classify */
	}
	return out;
}

async function listModelsUncached(): Promise<{
	providers: ProviderView[];
	models: ModelView[];
}> {
	const rt = await getModelRuntime();
	const builtInProviderIds = await getBuiltInProviderIds();
	const providers = rt.getProviders() as any[];
	const storedAuthTypes = await readStoredAuthTypes();
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
			storedAuthType: auth?.source === "stored" ? storedAuthTypes.get(pid) : undefined,
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
	const pl = createPendingLogin(providerId);
	const rt = await getLoginRuntime(pl);
	await runLogin(pl, rt, "api_key", apiKey);
}

export async function removeApiKey(providerId: string): Promise<void> {
	// A device-code login must not keep logout queued or restore credentials later.
	cancelLogin(providerId);
	const rt = await getModelRuntime();
	await rt.logout(providerId);
	invalidateModelList();
}

/** 已存凭证回退：编辑表单的 key 框为空（「留空保持不变」）时，从这里取。oauth=true 表示来自 OAuth 令牌（部分端点不适用）。 */
async function storedCredentialFor(providerId: string): Promise<{ key: string; oauth: boolean; accountId?: string } | undefined> {
	// 自定义 provider / 内置覆盖层：models.json providers[id].apiKey。
	// 损坏/权限失败不能静默回退到别的凭证；JSONC 与编辑器使用相同解析规则。
	const custom = await readCustomProvidersSnapshot(modelsJsonPath());
	if (custom.content !== undefined) {
		const key = parseCustomProviders(custom.content).providers[providerId]?.apiKey;
		if (typeof key === "string" && key.trim()) return { key: key.trim(), oauth: false };
	}
	// 内置 provider：auth.json 条目 —— API key 直接用；OAuth 条目的 access 就是
	// SDK 发请求时的 Bearer key（如 xai 的 toAuth 返回 { apiKey: credential.access }）
	try {
		const parsed = JSON.parse(await fs.readFile(path.join(getAgentDir(), "auth.json"), "utf8")) as Record<string, any>;
		const entry = parsed?.[providerId] ?? parsed?.providers?.[providerId];
		const key = entry?.apiKey ?? entry?.api_key ?? entry?.key;
		if (typeof key === "string" && key.trim()) return { key: key.trim(), oauth: false };
		if (entry?.type === "oauth" && typeof entry?.access === "string" && entry.access.trim()) {
			const accountId = typeof entry.accountId === "string" && entry.accountId.trim() ? entry.accountId.trim() : undefined;
			return { key: entry.access.trim(), oauth: true, ...(accountId === undefined ? {} : { accountId }) };
		}
	} catch {
		/* 同上 */
	}
	return undefined;
}

function modelsEndpoint(value: URL): URL {
	const url = new URL(value);
	const path = url.pathname.replace(/\/+$/, "");
	url.pathname = path.endsWith("/models") ? path : `${path}/models`;
	url.hash = "";
	return url;
}

export function isTrustedCredentialEndpoint(target: URL, configuredUrls: Array<string | undefined>): boolean {
	const expected = modelsEndpoint(target).href;
	return configuredUrls.some((value) => {
		if (!value) return false;
		try {
			const configured = new URL(value);
			return !configured.username && !configured.password && modelsEndpoint(configured).href === expected;
		} catch {
			return false;
		}
	});
}

const MAX_MODEL_CATALOG_BYTES = 4 * 1024 * 1024;

const blockedIpv4 = new BlockList();
for (const [address, prefix] of [
	["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
	["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
	["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
	["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blockedIpv4.addSubnet(address, prefix, "ipv4");
const globalIpv6 = new BlockList();
globalIpv6.addSubnet("2000::", 3, "ipv6");
const blockedIpv6 = new BlockList();
for (const [address, prefix] of [
	["2001::", 23], ["2001:db8::", 32], ["2002::", 16],
] as const) blockedIpv6.addSubnet(address, prefix, "ipv6");

export function isPublicModelDiscoveryAddress(address: string): boolean {
	const family = isIP(address);
	if (family === 4) return !blockedIpv4.check(address, "ipv4");
	if (family === 6) return globalIpv6.check(address, "ipv6") && !blockedIpv6.check(address, "ipv6");
	return false;
}

async function requestModelCatalog(endpoint: URL, headers: Record<string, string>, signal: AbortSignal, allowPrivate = false): Promise<Response> {
	// 显式勾选（本次允许访问本机/私网）或全局环境变量，二选一放行
	const allowed = allowPrivate || process.env.PI_WEB_ALLOW_PRIVATE_MODEL_DISCOVERY === "1";
	const literalFamily = isIP(endpoint.hostname.replace(/^\[|\]$/g, ""));
	if (!allowed && literalFamily && !isPublicModelDiscoveryAddress(endpoint.hostname.replace(/^\[|\]$/g, ""))) {
		throw new Error("模型目录地址指向本机或私有网络；勾选「允许访问本机/私有网络地址」后重试，或设置 PI_WEB_ALLOW_PRIVATE_MODEL_DISCOVERY=1");
	}
	return new Promise<Response>((resolve, reject) => {
		const request = (endpoint.protocol === "https:" ? httpsRequest : httpRequest)(endpoint, {
			headers,
			signal,
			agent: false,
			lookup: allowed ? undefined : (hostname, options, callback) => {
				void dns.lookup(hostname, { all: true }).then((addresses) => {
					const publicAddress = addresses.find(({ address }) => isPublicModelDiscoveryAddress(address));
					if (!publicAddress) {
						callback(new Error("模型目录地址指向本机或私有网络；勾选「允许访问本机/私有网络地址」后重试，或设置 PI_WEB_ALLOW_PRIVATE_MODEL_DISCOVERY=1"), "", 0);
						return;
					}
					if (options.all) callback(null, [publicAddress]);
					else callback(null, publicAddress.address, publicAddress.family);
				}, (error) => callback(error, "", 0));
			},
		}, (response) => {
			const status = response.statusCode ?? 0;
			if (status >= 300 && status < 400) {
				response.destroy();
				reject(new Error("模型目录不允许重定向"));
				return;
			}
			const chunks: Buffer[] = [];
			let size = 0;
			const declaredSize = Number(response.headers["content-length"]);
			if (declaredSize > MAX_MODEL_CATALOG_BYTES) {
				response.destroy();
				reject(new Error("模型目录响应过大（上限 4 MiB）"));
				return;
			}
			response.on("data", (chunk: Buffer) => {
				size += chunk.length;
				if (size > MAX_MODEL_CATALOG_BYTES) {
					response.destroy();
					reject(new Error("模型目录响应过大（上限 4 MiB）"));
					return;
				}
				chunks.push(chunk);
			});
			response.on("error", reject);
			response.on("close", () => {
				if (!response.complete) reject(new Error("模型目录连接提前关闭"));
			});
			response.on("end", () => resolve(new Response(status === 204 || status === 205 || status === 304 ? null : Buffer.concat(chunks, size), { status })));
		});
		request.on("error", reject);
		request.end();
	});
}

async function readModelCatalog(response: Response): Promise<unknown> {
	const declaredSize = Number(response.headers.get("content-length"));
	if (declaredSize > MAX_MODEL_CATALOG_BYTES) throw new Error("模型目录响应过大（上限 4 MiB）");
	if (!response.body) throw new Error("模型目录响应为空");
	const reader = response.body.getReader();
	const chunks: Buffer[] = [];
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > MAX_MODEL_CATALOG_BYTES) throw new Error("模型目录响应过大（上限 4 MiB）");
			chunks.push(Buffer.from(value));
		}
	} finally {
		await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
	return JSON.parse(Buffer.concat(chunks, size).toString("utf8")) as unknown;
}

/** Fetch a provider's conventional /models catalog without persisting credentials. */
export async function discoverModels(input: { baseUrl: string; api?: string; apiKey?: string; providerId?: string; allowPrivate?: boolean }): Promise<DiscoveredModel[]> {
	const rawBaseUrl = input.baseUrl.trim();
	if (!rawBaseUrl) throw new Error("缺少 API 地址");
	const base = new URL(rawBaseUrl);
	if (base.protocol !== "http:" && base.protocol !== "https:") throw new Error("API 地址必须使用 http 或 https");
	if (base.username || base.password) throw new Error("API 地址不能包含用户名或密码");
	const endpoint = modelsEndpoint(base);
	const headers: Record<string, string> = { Accept: "application/json" };
	// 表单 key 为空时回退到该 provider 的已存凭证（编辑场景：占位符「留空保持不变」）
	const credential = input.apiKey?.trim()
		? { key: input.apiKey.trim(), oauth: false }
		: input.providerId
			? await storedCredentialFor(input.providerId)
			: undefined;
	if (credential && !input.apiKey?.trim()) {
		const rt = await getModelRuntime();
		const provider = rt.getProviders().find((p) => p.id === input.providerId);
		const configuredUrls = [provider?.baseUrl, ...(provider ? rt.getModels(provider.id).map((model) => model.baseUrl) : [])];
		if (!isTrustedCredentialEndpoint(endpoint, configuredUrls)) {
			throw new Error("已存凭证只能用于该 Provider 已配置的 API 地址；新地址请显式填写密钥");
		}
	}
	const apiKey = credential?.key;
	// OpenAI Codex 的模型目录由 SDK 内置（chatgpt.com 后端无公开 /models），OAuth 令牌无法用于目录探测
	if (!input.apiKey?.trim() && credential?.oauth && input.providerId === "openai-codex") {
		throw new Error("OpenAI Codex 的模型目录由 SDK 内置，无需获取；如需自定义请手动添加模型 ID");
	}
	if (apiKey) {
		if (input.api === "anthropic-messages") {
			headers["x-api-key"] = apiKey;
			// Anthropic 的 OAuth 令牌必须带 beta 头才被接受（与 SDK 发消息时一致）
			if (credential?.oauth) headers["anthropic-beta"] = "oauth-2025-04-20";
		} else {
			headers.Authorization = `Bearer ${apiKey}`;
		}
	}
	if (input.api === "anthropic-messages") headers["anthropic-version"] = "2023-06-01";
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 15000);
		try {
			const response = await requestModelCatalog(endpoint, headers, controller.signal, input.allowPrivate === true);
			if (response.status === 401) {
				throw new Error(apiKey ? "模型目录请求失败（HTTP 401）：密钥或令牌无效" : "模型目录请求失败（HTTP 401）：请先填写 API 密钥");
			}
			if (response.status === 403) {
				throw new Error(credential?.oauth
					? "模型目录请求失败（HTTP 403）：该 OAuth 令牌无权访问模型目录（部分提供商不支持），请手动填写模型 ID"
					: "模型目录请求失败（HTTP 403）：密钥无权访问模型目录");
			}
			if (!response.ok) throw new Error(`模型目录请求失败（HTTP ${response.status}）`);
		const payload = await readModelCatalog(response);
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
		if (error && typeof error === "object" && "code" in error
			&& ["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EHOSTUNREACH", "ENETUNREACH", "ETIMEDOUT"].includes(String(error.code))) {
			throw new Error("无法连接模型目录，请检查 API 地址和网络");
		}
		if (error instanceof TypeError && error.message.toLowerCase().includes("fetch")) throw new Error("无法连接模型目录，请检查 API 地址和网络");
		throw error;
	} finally {
		clearTimeout(timeout);
	}
}

// ---------- 订阅配额 / 余额（各提供商各自的只读端点） ----------


const usageCache = new Map<string, { at: number; value: ProviderUsage | null }>();
const USAGE_TTL_MS = 5 * 60_000;

/**
 * 探测提供商的实时配额 / 余额。只有确实提供只读用量端点的提供商接入，
 * 没有端点的宁可留空也不做假开关。结果统一缓存 5 分钟，force 跳过缓存。
 */
export async function providerUsage(providerId: string, force = false): Promise<ProviderUsage | null> {
	const probe = usageProbeFor(providerId);
	if (!probe) return null;
	const cached = usageCache.get(providerId);
	if (!force && cached && Date.now() - cached.at < USAGE_TTL_MS) return cached.value;
	const value = await probe();
	usageCache.set(providerId, { at: Date.now(), value });
	return value;
}


function usageProbeFor(providerId: string): (() => Promise<ProviderUsage | null>) | null {
	switch (providerId) {
		case "xai": return probeXaiUsage;
		case "openai-codex": return probeCodexUsage;
		case "anthropic": return probeAnthropicUsage;
		case "deepseek": return probeDeepSeekBalance;
		case "openrouter": return probeOpenRouterBalance;
		case "moonshotai": return () => probeMoonshotBalance("moonshotai");
		case "moonshotai-cn": return () => probeMoonshotBalance("moonshotai-cn");
		case "kimi-coding": return probeKimiCodingUsage;
		case "github-copilot": return probeCopilotUsage;
		case "vercel-ai-gateway": return probeVercelGatewayBalance;
		case "opencode-go": return probeOpencodeUsage;
		default: return null;
	}
}

// ---------- Codex 周限（ChatGPT backend-api，只读） ----------

const CODEX_USAGE_ENDPOINT = "https://chatgpt.com/backend-api/wham/usage";
const USAGE_TIMEOUT_MS = 10_000;


/**
 * 共用的一次性只读探测：超时即放弃并取消响应体，任何失败都返回 undefined，
 * 由各调用方决定降级方式（有的回退到本地可得的套餐，有的整体留空）。
 */
async function fetchUsageJson(url: string, init: RequestInit, timeoutMs = USAGE_TIMEOUT_MS): Promise<unknown | undefined> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(url, { ...init, signal: controller.signal });
		if (!response.ok) {
			void response.body?.cancel().catch(() => {});
			return undefined;
		}
		return await response.json();
	} catch {
		return undefined;
	} finally {
		clearTimeout(timeout);
	}
}

/** 端点不可用时，只要本地能确定套餐就仍然给出套餐，避免整块空白。 */
function quotaWithPlanOnly(planType: string | undefined): QuotaUsage | null {
	return planType === undefined ? null : { kind: "quota", planType, windows: [], probedAt: Date.now() };
}

/** 载荷里只认对象，数组与标量一律视为无数据。 */
function asRecord(input: unknown): Record<string, any> | undefined {
	return input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, any>) : undefined;
}

/** ISO 字符串 → ISO 字符串；无法解析时返回 undefined 而不是把原始值透传出去。 */
function isoOrUndefined(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const parsed = new Date(value);
	return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : undefined;
}

/** 从 access token 的 JWT 本地读套餐声明：端点不可用时界面仍显示套餐。 */
export function planTypeFromAccessToken(accessToken: string): string | undefined {
	try {
		const payload = JSON.parse(Buffer.from(accessToken.split(".")[1] ?? "", "base64").toString("utf8")) as Record<string, any>;
		const value = payload?.["https://api.openai.com/auth"]?.chatgpt_plan_type;
		return typeof value === "string" && value.trim() ? value.trim() : undefined;
	} catch {
		return undefined;
	}
}

/**
 * /wham/usage 载荷里只取界面需要的部分。窗口组合随套餐不同：常见是 5 小时窗 +
 * 7 天窗，有的套餐只有 7 天窗，Go 这类只有 30 天窗（secondary_window 直接是
 * null）。所以不假设窗口数量与位置，把实际给出的窗口全列出来按时长升序排列，
 * 由界面如实标注每一项的周期。字段缺失即未知，不做猜测。
 */
export function parseCodexUsagePayload(value: unknown): Omit<QuotaUsage, "kind" | "probedAt"> {
	const root = asRecord(value);
	if (!root) return { windows: [] };
	const rateLimit = asRecord(root.rate_limit);
	const windows = [rateLimit?.primary_window, rateLimit?.secondary_window]
		.map(asRecord)
		.flatMap((candidate): QuotaWindow[] => {
			if (!candidate) return [];
			if (typeof candidate.limit_window_seconds !== "number" || candidate.limit_window_seconds <= 0) return [];
			if (typeof candidate.used_percent !== "number" || !Number.isFinite(candidate.used_percent)) return [];
			let resetAt: string | undefined;
			if (Number.isSafeInteger(candidate.reset_at) && candidate.reset_at > 0) {
				const reset = new Date(candidate.reset_at * 1000);
				if (Number.isFinite(reset.getTime())) resetAt = reset.toISOString();
			}
			return [{
				limitWindowSeconds: candidate.limit_window_seconds,
				remainingPercent: Math.min(100, Math.max(0, Math.round(100 - candidate.used_percent))),
				...(resetAt === undefined ? {} : { resetAt }),
			}];
		})
		.sort(byWindowLength);
	const plan = root.plan_type;
	return {
		...(typeof plan === "string" && plan.trim() ? { planType: plan.trim() } : {}),
		windows,
	};
}

async function probeCodexUsage(): Promise<QuotaUsage | null> {
	const credential = await storedCredentialFor("openai-codex");
	if (!credential) return null;
	// JWT 里的套餐声明本地可得，端点失败时用它兜底，界面不至于整块空白
	const fallbackPlan = planTypeFromAccessToken(credential.key);
	const payload = await fetchUsageJson(CODEX_USAGE_ENDPOINT, {
		headers: {
			Authorization: `Bearer ${credential.key}`,
			...(credential.accountId ? { "chatgpt-account-id": credential.accountId } : {}),
		},
	});
	if (payload === undefined) return quotaWithPlanOnly(fallbackPlan);
	const parsed = parseCodexUsagePayload(payload);
	const planType = parsed.planType ?? fallbackPlan;
	return { kind: "quota", ...parsed, ...(planType === undefined ? {} : { planType }), probedAt: Date.now() };
}

// ---------- Claude 订阅（Anthropic 只读用量端点） ----------

const ANTHROPIC_USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
/** OAuth 令牌访问该端点需要显式带上的 beta 头。 */
const ANTHROPIC_USAGE_BETA = "oauth-2025-04-20";
const HOUR_SECONDS = 60 * 60;

/**
 * /api/oauth/usage 把窗口放在 five_hour / seven_day / seven_day_opus 三个固定字段，
 * utilization 是 0-100 的「已用」百分比（同名的 anthropic-ratelimit-unified-* 响应头
 * 给的是 0-1 比例，两处口径不同）。字段缺失就是没有该窗口，不按 0 补齐。
 */
export function parseAnthropicUsagePayload(value: unknown): Omit<QuotaUsage, "kind" | "probedAt"> {
	const root = asRecord(value);
	if (!root) return { windows: [] };
	const pick = (key: string, seconds: number, variant?: string): QuotaWindow[] => {
		const entry = asRecord(root[key]);
		if (!entry || typeof entry.utilization !== "number" || !Number.isFinite(entry.utilization)) return [];
		const resetAt = isoOrUndefined(entry.resets_at);
		return [{
			limitWindowSeconds: seconds,
			remainingPercent: Math.min(100, Math.max(0, Math.round(100 - entry.utilization))),
			...(resetAt === undefined ? {} : { resetAt }),
			...(variant === undefined ? {} : { variant }),
		}];
	};
	const windows = [
		...pick("five_hour", 5 * HOUR_SECONDS),
		...pick("seven_day", WEEKLY_WINDOW_SECONDS),
		...pick("seven_day_opus", WEEKLY_WINDOW_SECONDS, "opus"),
	].sort(byWindowLength);
	return { windows };
}

async function probeAnthropicUsage(): Promise<QuotaUsage | null> {
	const credential = await storedCredentialFor("anthropic");
	// 该端点只认订阅 OAuth 令牌；API key 走的是按量计费，没有这组窗口
	if (!credential?.oauth) return null;
	const payload = await fetchUsageJson(ANTHROPIC_USAGE_ENDPOINT, {
		headers: { Authorization: `Bearer ${credential.key}`, "anthropic-beta": ANTHROPIC_USAGE_BETA },
	});
	if (payload === undefined) return null;
	const parsed = parseAnthropicUsagePayload(payload);
	return parsed.windows.length === 0 ? null : { kind: "quota", ...parsed, probedAt: Date.now() };
}

// ---------- 余额制提供商（各家官方余额端点） ----------

/** 金额字段统一按「有限数字」校验后保留两位；其余一律视为无数据。 */
function amountOrUndefined(value: unknown, currency?: string): BalanceAmount | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return { amount: value.toFixed(2), ...(currency === undefined ? {} : { currency }) };
	if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
		return { amount: Number(value).toFixed(2), ...(currency === undefined ? {} : { currency }) };
	}
	return undefined;
}

/** DeepSeek：GET /user/balance，金额是字符串，币种跟着账户（CNY 或 USD）。 */
export function parseDeepSeekBalancePayload(value: unknown): Omit<BalanceUsage, "kind" | "probedAt"> {
	const root = asRecord(value);
	const infos = Array.isArray(root?.balance_infos) ? root.balance_infos.map(asRecord).filter(Boolean) : [];
	const info = infos[0];
	if (!info) return { details: [] };
	const currency = typeof info.currency === "string" && info.currency.trim() ? info.currency.trim() : undefined;
	const details: BalanceUsage["details"] = [];
	const granted = amountOrUndefined(info.granted_balance, currency);
	if (granted) details.push({ key: "granted", ...granted });
	const toppedUp = amountOrUndefined(info.topped_up_balance, currency);
	if (toppedUp) details.push({ key: "toppedUp", ...toppedUp });
	const total = amountOrUndefined(info.total_balance, currency);
	return { ...(total === undefined ? {} : { primary: total }), details };
}

/** OpenRouter：GET /api/v1/key，额度以美元计；无上限的 key 没有 limit_remaining。 */
export function parseOpenRouterKeyPayload(value: unknown): Omit<BalanceUsage, "kind" | "probedAt"> {
	const data = asRecord(asRecord(value)?.data);
	if (!data) return { details: [] };
	const details: BalanceUsage["details"] = [];
	const limit = amountOrUndefined(data.limit, "USD");
	if (limit) details.push({ key: "limit", ...limit });
	const used = amountOrUndefined(data.usage, "USD");
	if (used) details.push({ key: "used", ...used });
	const remaining = amountOrUndefined(data.limit_remaining, "USD");
	if (remaining) return { primary: remaining, details };
	// 无上限时没有剩余额度可显示，退回累计已用
	return used ? { primaryKey: "used", primary: used, details } : { details };
}

/** Moonshot / Kimi：GET /v1/users/me/balance，国内站记 CNY、海外站记 USD，两者密钥不通用。 */
export function parseMoonshotBalancePayload(value: unknown, currency: string): Omit<BalanceUsage, "kind" | "probedAt"> {
	const root = asRecord(value);
	const data = asRecord(root?.data);
	if (!data || root?.status === false) return { details: [] };
	const details: BalanceUsage["details"] = [];
	const voucher = amountOrUndefined(data.voucher_balance, currency);
	if (voucher) details.push({ key: "voucher", ...voucher });
	const cash = amountOrUndefined(data.cash_balance, currency);
	if (cash) details.push({ key: "cash", ...cash });
	const available = amountOrUndefined(data.available_balance, currency);
	return { ...(available === undefined ? {} : { primary: available }), details };
}

const MOONSHOT_HOSTS: Record<string, { base: string; currency: string }> = {
	moonshotai: { base: "https://api.moonshot.ai", currency: "USD" },
	"moonshotai-cn": { base: "https://api.moonshot.cn", currency: "CNY" },
};

async function probeDeepSeekBalance(): Promise<BalanceUsage | null> {
	const credential = await storedCredentialFor("deepseek");
	if (!credential) return null;
	const payload = await fetchUsageJson("https://api.deepseek.com/user/balance", {
		headers: { Authorization: `Bearer ${credential.key}` },
	});
	if (payload === undefined) return null;
	return { kind: "balance", ...parseDeepSeekBalancePayload(payload), probedAt: Date.now() };
}

async function probeOpenRouterBalance(): Promise<BalanceUsage | null> {
	const credential = await storedCredentialFor("openrouter");
	if (!credential) return null;
	const payload = await fetchUsageJson("https://openrouter.ai/api/v1/key", {
		headers: { Authorization: `Bearer ${credential.key}` },
	});
	if (payload === undefined) return null;
	return { kind: "balance", ...parseOpenRouterKeyPayload(payload), probedAt: Date.now() };
}

async function probeMoonshotBalance(providerId: "moonshotai" | "moonshotai-cn"): Promise<BalanceUsage | null> {
	const credential = await storedCredentialFor(providerId);
	if (!credential) return null;
	const host = MOONSHOT_HOSTS[providerId];
	const payload = await fetchUsageJson(`${host.base}/v1/users/me/balance`, {
		headers: { Authorization: `Bearer ${credential.key}` },
	});
	if (payload === undefined) return null;
	return { kind: "balance", ...parseMoonshotBalancePayload(payload, host.currency), probedAt: Date.now() };
}

// ---------- 订阅制订阅额度（Kimi Code / GitHub Copilot / OpenCode Go） ----------

/** 0-1 的 used_ratio 或 0-100 的已用百分比统一转成剩余百分比。 */
function remainingFromUsed(used: number): number {
	return Math.min(100, Math.max(0, Math.round(100 - used)));
}

/** 短周期在前；没有周期的窗口（Copilot 类别、rolling）排在最后。 */
function byWindowLength(left: QuotaWindow, right: QuotaWindow): number {
	return (left.limitWindowSeconds ?? Number.POSITIVE_INFINITY) - (right.limitWindowSeconds ?? Number.POSITIVE_INFINITY);
}

/**
 * Kimi Code：GET /coding/v1/usages。四个固定键给 used_ratio（0-1 的小数，与
 * Claude 的 0-100 口径不同）和 reset_time；月度总额度与月度代码额度周期相同，
 * 靠 variant 区分。
 */
export function parseKimiCodingUsagePayload(value: unknown): Omit<QuotaUsage, "kind" | "probedAt"> {
	const usages = asRecord(asRecord(value)?.usages);
	if (!usages) return { windows: [] };
	const pick = (key: string, seconds: number, variant?: string): QuotaWindow[] => {
		const entry = asRecord(usages[key]);
		if (!entry || typeof entry.used_ratio !== "number" || !Number.isFinite(entry.used_ratio)) return [];
		const resetAt = isoOrUndefined(entry.reset_time);
		return [{
			limitWindowSeconds: seconds,
			remainingPercent: remainingFromUsed(entry.used_ratio * 100),
			...(resetAt === undefined ? {} : { resetAt }),
			...(variant === undefined ? {} : { variant }),
		}];
	};
	const windows = [
		...pick("limit_5h", 5 * HOUR_SECONDS),
		...pick("limit_7d", WEEKLY_WINDOW_SECONDS),
		...pick("limit_month_total", MONTHLY_WINDOW_SECONDS),
		...pick("limit_month_code", MONTHLY_WINDOW_SECONDS, "code"),
	].sort(byWindowLength);
	return { windows };
}

/**
 * GitHub Copilot：GET /copilot_internal/user（VS Code 自己就用这条，未进官方
 * REST 文档）。quota_snapshots 按用途分档而不是按时间窗口，percent_remaining 是
 * 0-100 的剩余百分比；unlimited 的档位没有可跟踪的额度，跳过不占位置。
 */
export function parseCopilotUserPayload(value: unknown): Omit<QuotaUsage, "kind" | "probedAt"> {
	const root = asRecord(value);
	if (!root) return { windows: [] };
	const snapshots = asRecord(root.quota_snapshots);
	const plan = root.copilot_plan;
	const resetAt = isoOrUndefined(root.quota_reset_date);
	const names: Array<[string, string]> = [["premium_interactions", "premium"], ["chat", "chat"], ["completions", "completions"]];
	const windows = names.flatMap(([raw, name]): QuotaWindow[] => {
		const snapshot = asRecord(snapshots?.[raw]);
		if (!snapshot) return [];
		if (snapshot.has_quota === false || snapshot.unlimited === true) return [];
		if (typeof snapshot.percent_remaining !== "number" || !Number.isFinite(snapshot.percent_remaining)) return [];
		return [{
			remainingPercent: Math.min(100, Math.max(0, Math.round(snapshot.percent_remaining))),
			...(resetAt === undefined ? {} : { resetAt }),
			name,
		}];
	});
	return {
		...(typeof plan === "string" && plan.trim() ? { planType: plan.trim() } : {}),
		windows,
	};
}

/** Vercel AI Gateway：GET /v1/credits，美元字符串形式的余额与累计已用。 */
export function parseVercelGatewayCreditsPayload(value: unknown): Omit<BalanceUsage, "kind" | "probedAt"> {
	const root = asRecord(value);
	if (!root) return { details: [] };
	const details: BalanceUsage["details"] = [];
	const used = amountOrUndefined(root.total_used, "USD");
	if (used) details.push({ key: "used", ...used });
	const balance = amountOrUndefined(root.balance, "USD");
	return { ...(balance === undefined ? {} : { primary: balance }), details };
}

/**
 * OpenCode Go：GET /zen/go/v1/usage。三个窗口的 percent 是「已用」百分比
 * （服务端字段名就是 usagePercent），剩余要反算。rolling 的周期服务端不返回，
 * 所以只给名字不给时长；weekly / monthly 按名字标注。
 */
export function parseOpencodeUsagePayload(value: unknown): Omit<QuotaUsage, "kind" | "probedAt"> {
	const usage = asRecord(asRecord(value)?.usage);
	if (!usage) return { windows: [] };
	const pick = (key: string, seconds?: number): QuotaWindow[] => {
		const entry = asRecord(usage[key]);
		if (!entry || typeof entry.percent !== "number" || !Number.isFinite(entry.percent)) return [];
		const resetAt = isoOrUndefined(entry.resetsAt);
		return [{
			...(seconds === undefined ? { name: key } : { limitWindowSeconds: seconds }),
			remainingPercent: remainingFromUsed(entry.percent),
			...(resetAt === undefined ? {} : { resetAt }),
		}];
	};
	const windows = [
		...pick("rolling"),
		...pick("weekly", WEEKLY_WINDOW_SECONDS),
		...pick("monthly", MONTHLY_WINDOW_SECONDS),
	].sort(byWindowLength);
	return { windows };
}

async function probeKimiCodingUsage(): Promise<QuotaUsage | null> {
	const credential = await storedCredentialFor("kimi-coding");
	if (!credential) return null;
	const payload = await fetchUsageJson("https://api.kimi.com/coding/v1/usages", {
		headers: { Authorization: `Bearer ${credential.key}`, Accept: "application/json" },
	});
	if (payload === undefined) return null;
	const parsed = parseKimiCodingUsagePayload(payload);
	return parsed.windows.length === 0 ? null : { kind: "quota", ...parsed, probedAt: Date.now() };
}

async function probeCopilotUsage(): Promise<QuotaUsage | null> {
	const credential = await storedCredentialFor("github-copilot");
	if (!credential?.oauth) return null;
	// 凭据本身就是 Copilot 令牌（tid=...），直接可用于这个内部端点
	const payload = await fetchUsageJson("https://api.github.com/copilot_internal/user", {
		headers: { Authorization: `Bearer ${credential.key}`, Accept: "application/json" },
	});
	if (payload === undefined) return null;
	const parsed = parseCopilotUserPayload(payload);
	return parsed.windows.length === 0 && parsed.planType === undefined ? null : { kind: "quota", ...parsed, probedAt: Date.now() };
}

async function probeVercelGatewayBalance(): Promise<BalanceUsage | null> {
	const credential = await storedCredentialFor("vercel-ai-gateway");
	if (!credential) return null;
	const payload = await fetchUsageJson("https://ai-gateway.vercel.sh/v1/credits", {
		headers: { Authorization: `Bearer ${credential.key}` },
	});
	if (payload === undefined) return null;
	return { kind: "balance", ...parseVercelGatewayCreditsPayload(payload), probedAt: Date.now() };
}

async function probeOpencodeUsage(): Promise<QuotaUsage | null> {
	const credential = await storedCredentialFor("opencode-go");
	if (!credential) return null;
	const payload = await fetchUsageJson("https://opencode.ai/zen/go/v1/usage", {
		headers: { Authorization: `Bearer ${credential.key}`, Accept: "application/json" },
	});
	if (payload === undefined) return null;
	const parsed = parseOpencodeUsagePayload(payload);
	return parsed.windows.length === 0 ? null : { kind: "quota", ...parsed, probedAt: Date.now() };
}

async function probeXaiUsage(): Promise<XaiUsage | null> {
	const credential = await storedCredentialFor("xai");
	if (!credential) return null;
	const key = credential.key;
	let model = "";
	try {
		const rt = await getModelRuntime();
		const models = rt.getModels("xai") as any[];
		// 限额是按模型计算的：挑最新主力文本模型（grok-4.6 > 4.5 > 4.3），
		// 排除 imagine（不走对话接口）与 multi-agent（需 beta）
		const usable = models
			.map((m) => String(m.id))
			.filter((id) => !id.includes("imagine") && !id.includes("multi-agent"));
		model = ["grok-4.6", "grok-4.5", "grok-4.3"].find((want) => usable.some((id) => id === want || id.startsWith(`${want}-`))) ?? usable[0] ?? "";
	} catch {
		return null;
	}
	if (!model) return null;
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 20_000);
	try {
		const response = await fetch("https://api.x.ai/v1/chat/completions", {
			method: "POST",
			headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
			body: JSON.stringify({ model, messages: [{ role: "user", content: "ping" }], max_tokens: 1 }),
			signal: controller.signal,
		});
		void response.body?.cancel().catch(() => {});
		const get = (name: string) => Number(response.headers.get(name) ?? NaN);
		const requestLimit = get("x-ratelimit-limit-requests");
		const requestRemaining = get("x-ratelimit-remaining-requests");
		const tokenLimit = get("x-ratelimit-limit-tokens");
		const tokenRemaining = get("x-ratelimit-remaining-tokens");
		if (![requestLimit, requestRemaining, tokenLimit, tokenRemaining].every(Number.isFinite)) return null;
		return { kind: "xai", model, requestLimit, requestRemaining, tokenLimit, tokenRemaining, probedAt: Date.now() };
	} catch {
		return null;
	} finally {
		clearTimeout(timeout);
	}
}

// ---------- OAuth 订阅登录（Claude/Codex/Copilot 等） ----------

interface PendingLogin {
	providerId: string;
	controller: AbortController;
	timeout: ReturnType<typeof setTimeout> | null;
	prompt: AuthPrompt | null;
	resolver: ((value: string) => void) | null;
	rejecter: ((err: Error) => void) | null;
	notifyLog: string[];
	done: boolean;
	error?: string;
	finishedAt?: number;
}

const pendingLogins = new Map<string, PendingLogin>();
const LOGIN_TIMEOUT_MS = 10 * 60_000;

/** 清理已完成且超过 10 分钟的登录条目，避免长期运行内存缓慢增长。 */
function purgeFinishedLogins(): void {
	const now = Date.now();
	for (const [id, pl] of pendingLogins) {
		if (pl.done && pl.finishedAt !== undefined && now - pl.finishedAt > 10 * 60_000) pendingLogins.delete(id);
	}
}

function isActiveLogin(pl: PendingLogin): boolean {
	return pendingLogins.get(pl.providerId) === pl && !pl.done && !pl.controller.signal.aborted;
}

function assertActiveLogin(pl: PendingLogin): void {
	pl.controller.signal.throwIfAborted();
	if (!isActiveLogin(pl)) throw new Error("canceled");
}

function finishLogin(pl: PendingLogin, error?: unknown): boolean {
	// Late completions/callbacks must never revive a canceled or replaced job.
	if (pendingLogins.get(pl.providerId) !== pl || pl.done) return false;
	pl.done = true;
	if (error !== undefined) pl.error = error instanceof Error ? error.message : String(error);
	pl.finishedAt = Date.now();
	if (pl.timeout) clearTimeout(pl.timeout);
	pl.timeout = null;
	pl.rejecter?.(error instanceof Error ? error : new Error(pl.error ?? "login finished"));
	pl.prompt = null;
	pl.resolver = null;
	pl.rejecter = null;
	return true;
}

function abortLogin(pl: PendingLogin, error: Error): void {
	finishLogin(pl, error);
	// Public SDK contract: abort both the device-code flow and its queued credential write.
	pl.controller.abort(error);
}

function createPendingLogin(providerId: string): PendingLogin {
	purgeFinishedLogins();
	const previous = pendingLogins.get(providerId);
	if (previous && !previous.done) abortLogin(previous, new Error("canceled"));
	const pl: PendingLogin = {
		providerId, controller: new AbortController(), timeout: null,
		prompt: null, resolver: null, rejecter: null, notifyLog: [], done: false,
	};
	pendingLogins.set(providerId, pl);
	pl.timeout = setTimeout(() => abortLogin(pl, new Error("login timed out")), LOGIN_TIMEOUT_MS);
	pl.timeout.unref?.();
	return pl;
}

async function getLoginRuntime(pl: PendingLogin): Promise<ModelRuntime> {
	try {
		const rt = await getModelRuntime();
		assertActiveLogin(pl);
		return rt;
	} catch (error) {
		finishLogin(pl, error);
		throw error;
	}
}

function promptForLogin(pl: PendingLogin, prompt: AuthPrompt): Promise<string> {
	assertActiveLogin(pl);
	const signal = prompt.signal ? AbortSignal.any([pl.controller.signal, prompt.signal]) : pl.controller.signal;
	signal.throwIfAborted();
	pl.rejecter?.(new Error("prompt replaced"));
	return new Promise<string>((resolve, reject) => {
		let settled = false;
		const cleanup = () => {
			signal.removeEventListener("abort", onAbort);
			if (pl.resolver === answer) {
				pl.prompt = null;
				pl.resolver = null;
				pl.rejecter = null;
			}
		};
		const answer = (value: string) => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(value);
		};
		const fail = (error: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		};
		const onAbort = () => fail(signal.reason instanceof Error ? signal.reason : new Error("canceled"));
		pl.prompt = prompt;
		pl.resolver = answer;
		pl.rejecter = fail;
		signal.addEventListener("abort", onAbort, { once: true });
		if (signal.aborted) onAbort();
	});
}

async function runLogin(pl: PendingLogin, rt: ModelRuntime, type: AuthType, apiKey?: string): Promise<void> {
	let firstTextAnswered = false;
	const interaction: AuthInteraction = {
		signal: pl.controller.signal,
		prompt: async (prompt) => {
			assertActiveLogin(pl);
			prompt.signal?.throwIfAborted();
			if (apiKey !== undefined && !firstTextAnswered && prompt.type !== "select") {
				firstTextAnswered = true;
				return apiKey;
			}
			return promptForLogin(pl, prompt);
		},
		notify: (event) => {
			if (!isActiveLogin(pl)) return;
			pl.notifyLog.push(typeof event === "string" ? event : JSON.stringify(event));
			if (pl.notifyLog.length > 20) pl.notifyLog.shift();
		},
	};
	try {
		assertActiveLogin(pl);
		await rt.login(pl.providerId, type, interaction);
		assertActiveLogin(pl);
		if (finishLogin(pl)) invalidateModelList();
	} catch (error) {
		finishLogin(pl, error);
		throw error;
	}
}

/** 启动 OAuth 登录（后台运行，交互经 pendingLogin 桥接到浏览器轮询） */
export async function startLogin(providerId: string): Promise<void> {
	const pl = createPendingLogin(providerId);
	const rt = await getLoginRuntime(pl);
	void runLogin(pl, rt, "oauth").catch(() => undefined); // terminal errors are exposed by loginState
}

export function loginState(providerId: string): {
	prompt: { type: string; message: string; placeholder?: string; options?: Array<{ label: string; value: string }> } | null;
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
					type: pl.prompt.type,
					message: pl.prompt.message,
					placeholder: "placeholder" in pl.prompt ? pl.prompt.placeholder : undefined,
					// select 型提示：answerLogin 回传 SDK 的选项 id，而不是 label。
					options: pl.prompt.type === "select"
						? pl.prompt.options.map((option) => ({ label: option.label, value: option.id }))
						: undefined,
				}
			: null,
		notifyLog: [...pl.notifyLog],
		done: pl.done,
		error: pl.error,
	};
}

export function answerLogin(providerId: string, text: string): boolean {
	const pl = pendingLogins.get(providerId);
	if (!pl || !isActiveLogin(pl) || !pl.resolver) return false;
	pl.resolver(text);
	return true;
}

export function cancelLogin(providerId: string): boolean {
	purgeFinishedLogins();
	const pl = pendingLogins.get(providerId);
	if (!pl) return false;
	if (!pl.done) abortLogin(pl, new Error("canceled"));
	return true;
}

// ---------- 自定义 provider（~/.pi/agent/models.json） ----------

function modelsJsonPath(): string {
	return path.join(getAgentDir(), "models.json");
}

interface CustomProvidersFile extends Record<string, unknown> {
	providers: Record<string, Record<string, unknown>>;
}

export class CustomProvidersValidationError extends Error {}
export class CustomProvidersConflictError extends Error {
	constructor() {
		super("models.json 已被修改，请重新加载后再保存");
	}
}

function parseCustomProviders(content: string): CustomProvidersFile {
	const errors: ParseError[] = [];
	const tree = parseTree(content.replace(/^\uFEFF/, ""), errors, { allowTrailingComma: true, allowEmptyContent: false });
	if (errors.length || !tree) {
		const first = errors[0];
		// Do not include a source excerpt: it may contain an API key.
		throw new CustomProvidersValidationError(`models.json JSONC 无效${first ? ` (${printParseErrorCode(first.error)}, offset ${first.offset})` : ""}`);
	}
	// getNodeValue uses null-prototype objects, so keys such as __proto__ round-trip as data.
	const parsed: unknown = getNodeValue(tree);
	if (!isRecord(parsed) || !isRecord(parsed.providers)) {
		throw new CustomProvidersValidationError('models.json 顶层必须是 { "providers": { ... } }');
	}
	for (const [id, provider] of Object.entries(parsed.providers)) {
		if (!isRecord(provider)) throw new CustomProvidersValidationError(`provider "${id}" 必须是对象`);
	}
	return parsed as CustomProvidersFile;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function redactCustomProviderSecrets(content: string): { content: string; secretProviderIds: string[] } {
	const parsed = parseCustomProviders(content);
	const secretProviderIds: string[] = [];
	for (const [id, provider] of Object.entries(parsed.providers)) {
		if (!Object.prototype.hasOwnProperty.call(provider, "apiKey")) continue;
		delete provider.apiKey;
		secretProviderIds.push(id);
	}
	return { content: JSON.stringify(parsed, null, 2), secretProviderIds };
}

function mergeCustomProviderApiKeys(parsed: CustomProvidersFile, previous: CustomProvidersFile): void {
	for (const [id, provider] of Object.entries(parsed.providers)) {
		// 字段缺失（包括 JSON.stringify 省略的 undefined）保留旧密钥；只有显式 null 删除。
		if (provider.apiKey === null) {
			delete provider.apiKey;
		} else if (provider.apiKey === undefined) {
			const previousProvider = previous.providers[id];
			if (previousProvider && Object.prototype.hasOwnProperty.call(previousProvider, "apiKey")) {
				provider.apiKey = previousProvider.apiKey;
			}
		}
	}
}

/** 本地/回环地址的无鉴权网关（Ollama 等）：SDK 设计上必须给 apiKey 才算「已配置」；占位值 "unused" 是官方认可模式 */
function applyLocalPlaceholderKeys(parsed: CustomProvidersFile): void {
	for (const provider of Object.values(parsed.providers)) {
		if (provider.apiKey === undefined && typeof provider.baseUrl === "string"
			&& /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(provider.baseUrl.trim())) {
			provider.apiKey = "unused";
		}
	}
}

export function preserveCustomProviderApiKeys(content: string, previousContent: string): string {
	const parsed = parseCustomProviders(content);
	mergeCustomProviderApiKeys(parsed, parseCustomProviders(previousContent));
	return JSON.stringify(parsed, null, 2);
}

async function readCustomProvidersSnapshot(file: string): Promise<{ content: string | undefined; revision: string }> {
	try {
		const content = await fs.readFile(file, "utf8");
		return { content, revision: createHash("sha256").update(content).digest("hex") };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		return { content: undefined, revision: "missing" };
	}
}

export async function readCustomProviders(): Promise<{ content: string; exists: boolean; secretProviderIds: string[]; revision: string }> {
	const snapshot = await readCustomProvidersSnapshot(modelsJsonPath());
	return {
		...redactCustomProviderSecrets(snapshot.content ?? '{"providers":{}}'),
		exists: snapshot.content !== undefined,
		revision: snapshot.revision,
	};
}

function validateTokenLimits(parsed: CustomProvidersFile): void {
	for (const [id, provider] of Object.entries(parsed.providers)) {
		if (!id.trim()) throw new CustomProvidersValidationError("provider ID 必须是非空字符串");
		const models = Array.isArray(provider.models) ? provider.models : [];
		const overrides = isRecord(provider.modelOverrides) ? Object.values(provider.modelOverrides) : [];
		for (const model of [...models, ...overrides]) {
			if (!isRecord(model)) continue; // Full structural validation is delegated to the SDK below.
			for (const field of ["contextWindow", "maxTokens"] as const) {
				if (model[field] === undefined) continue;
				if (typeof model[field] !== "number" || !Number.isSafeInteger(model[field]) || model[field] <= 0) {
					throw new CustomProvidersValidationError(`provider "${id}" 的 ${field} 必须是正整数`);
				}
			}
		}
	}
}

async function validateStagedCustomProviders(file: string): Promise<void> {
	// Only the public SDK schema/composition contract. No auth files, network, commands,
	// model refresh, or extension/resource loading participate in configuration validation.
	const runtime = await ModelRuntime.create({
		modelsPath: file,
		credentials: new InMemoryCredentialStore(),
		modelsStore: new InMemoryModelsStore(),
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	const error = runtime.getError();
	if (error) throw new CustomProvidersValidationError(error);
}

export async function writeCustomProviders(content: string, revision?: string): Promise<void> {
	const file = modelsJsonPath();
	await withSettingsWriteLock(file, () => withExternalSettingsLock(file, async () => {
		const previous = await readCustomProvidersSnapshot(file);
		// Compare before parsing or restoring secrets; stale clients must reload, not overwrite.
		if (revision !== undefined && revision !== previous.revision) throw new CustomProvidersConflictError();
		const parsed = parseCustomProviders(content);
		const old = parseCustomProviders(previous.content ?? '{"providers":{}}');
		const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
		try {
			if (previous.content !== undefined) {
				await fs.writeFile(temporary, JSON.stringify(old, null, 2), { encoding: "utf8", flag: "wx", mode: 0o600 });
				// A damaged existing config is never treated as an empty/missing file.
				await validateStagedCustomProviders(temporary);
			}
			mergeCustomProviderApiKeys(parsed, old);
			// 本地网关无 key 也得给占位值，否则 SDK 判定「未配置」→ 发消息报 No API key
			applyLocalPlaceholderKeys(parsed);
			validateTokenLimits(parsed);
			await fs.writeFile(temporary, JSON.stringify(parsed, null, 2), {
				encoding: "utf8", flag: previous.content === undefined ? "wx" : "w", mode: 0o600,
			});
			await validateStagedCustomProviders(temporary);
			// Also detect non-cooperating writers that changed the file during validation.
			if ((await readCustomProvidersSnapshot(file)).revision !== previous.revision) throw new CustomProvidersConflictError();
			await fs.rename(temporary, file);
		} finally {
			await fs.rm(temporary, { force: true }).catch(() => undefined);
		}
	}));
	resetModelRuntime();
	invalidateModelList();
	// 已打开的会话持有保存前的旧 runtime：不清掉的话，在里面选新 provider 的模型
	// 会报 "No API key for X"（新 runtime 有配置，旧 runtime 查不到）。让活跃会话就地重建。
	await reloadSessionsForCwd();
}
