import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import { peekSessionModelRuntime } from "@/lib/agent-manager";
import { BoundaryError, resolveSessionPath, resolveWorkspacePath } from "@/lib/path-security";
import { apiError } from "@/lib/api-error";
import {
	answerLogin,
	builtinCatalogModelIds,
	cancelLogin,
	contextWindowInfo,
	CustomProvidersConflictError,
	CustomProvidersValidationError,
	discoverModels,
	listModels,
	listModelsForPiWeb,
	listWorkspaceModelsForPiWeb,
	loginState,
	providerUsage,
	readCustomProviders,
	resolveCustomModelCapabilities,
	removeApiKey,
	setApiKey,
	setModelContextWindow,
	setModelThinkingLevelMap,
	startLogin,
	thinkingProbe,
	writeCustomProviders,
} from "@/lib/models-service";
import { validateThinkingLevelMap } from "@/lib/thinking-probe";

export const dynamic = "force-dynamic";

function json(body: unknown, init: ResponseInit = {}) {
	const headers = new Headers(init.headers);
	headers.set("Cache-Control", "no-store");
	return NextResponse.json(body, { ...init, headers });
}

function publicLoginState(providerId: string) {
	const state = loginState(providerId);
	return state?.error ? { ...state, error: apiError(new Error(state.error), "认证未完成，请检查凭证或重新开始登录。").error } : state;
}

export async function GET(req: Request) {
	const params = new URL(req.url).searchParams;
	const custom = params.get("custom") === "1";
	const full = custom || params.get("full") === "1";
	try {
		const customProviders = custom ? await readCustomProviders() : null;
		const sessionId = !full ? params.get("session") : null;
		const cwd = !full && !sessionId && params.has("cwd") ? await resolveWorkspacePath(params.get("cwd")) : null;
		const sessionPath = sessionId ? await resolveSessionPath(sessionId, { allowPending: true }) : null;
		const runtime = sessionPath ? peekSessionModelRuntime(sessionPath) : undefined;
		let sessionCwd: string | null = null;
		if (sessionPath && !runtime) {
			// Read only the JSONL header. A cold catalog lookup must not initialize
			// an AgentSession or fall back to another workspace's global providers.
			const handle = await fs.open(sessionPath, "r").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
			if (handle) {
				try {
					const buffer = Buffer.alloc(16 * 1024); const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
					const line = buffer.subarray(0, bytesRead).toString("utf8").replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0];
					const header = JSON.parse(line);
					if (header.type !== "session" || typeof header.cwd !== "string") throw new BoundaryError("invalid session header");
					sessionCwd = await resolveWorkspacePath(header.cwd);
				} finally { await handle.close(); }
			} else if (params.has("cwd")) sessionCwd = await resolveWorkspacePath(params.get("cwd"));
			else throw new BoundaryError("未落盘或不存在的会话缺少工作区信息，无法读取模型目录。");
		}
		const data = await (full ? listModels() : sessionCwd || cwd ? listWorkspaceModelsForPiWeb((sessionCwd || cwd)!) : listModelsForPiWeb(runtime));
		// 页面挂载只需要选模型用的字段（1300+ 个模型带 api/baseUrl/cost/input 有 400KB）；设置页用 custom=1 拿完整版
		const models = full
			? data.models
			: data.models.map((m) => ({ provider: m.provider, id: m.id, name: m.name, reasoning: m.reasoning, thinkingLevels: m.thinkingLevels, contextWindow: m.contextWindow, input: m.input }));
		const providers = full
			? data.providers
			: data.providers.map((p) => ({ id: p.id, name: p.name, authReady: p.authReady, authError: p.authError, builtIn: p.builtIn, modelCount: p.modelCount }));
		// 设置页编辑内置 provider 时据此把「覆盖已有模型」写进 modelOverrides，而不是 models[]
		const catalogModelIds = customProviders ? await builtinCatalogModelIds(customProviders.content, data.models) : undefined;
		// 由 Next 的 HTTP 层统一压缩；预压缩 Response 的 Content-Encoding 会被新版适配器移除。
		return json(
			{ success: true, data: { providers, models, customProviders, ...(custom ? { capabilityResolutionAvailable: true } : {}), ...(catalogModelIds ? { catalogModelIds } : {}) } },
			{ headers: { "Cache-Control": "no-store" } },
		);
	} catch (err: any) {
		return json({ success: false, ...apiError(err, "模型目录暂时无法读取，请检查配置后重试。") }, { status: err instanceof BoundaryError ? 400 : 500 });
	}
}

export async function POST(req: Request) {
	try {
		const body = (await req.json()) as {
			action:
				| "setKey"
				| "removeKey"
				| "saveCustomProviders"
				| "resolveCapabilities"
				| "discoverModels"
				| "providerUsage"
				| "contextWindowInfo"
				| "setContextWindow"
				| "thinkingProbe"
				| "setThinkingLevelMap"
				| "loginStart"
				| "loginState"
				| "loginAnswer"
				| "loginCancel";
			providerId?: string;
			modelId?: string;
			contextWindow?: number;
			thinkingLevelMap?: unknown;
			apiKey?: string;
			baseUrl?: string;
			api?: string;
			content?: string;
			revision?: string;
			text?: string;
			force?: boolean;
			allowPrivate?: boolean;
			headers?: unknown;
		};
		if (!body || typeof body !== "object" || Array.isArray(body)) {
			return json({ success: false, error: "请求内容必须是一个对象。", errorCode: "VALIDATION_ERROR" }, { status: 400 });
		}
		if (body.action === "setKey") {
			if (!body.providerId || !body.apiKey) return json({ success: false, error: "missing fields" }, { status: 400 });
			await setApiKey(body.providerId, body.apiKey, { background: true });
			return json({ success: true, data: { accepted: true, ...publicLoginState(body.providerId) } }, { status: 202 });
		}
		if (body.action === "removeKey") {
			if (!body.providerId) return json({ success: false, error: "missing providerId" }, { status: 400 });
			await removeApiKey(body.providerId);
			return json({ success: true });
		}
		if (body.action === "saveCustomProviders") {
			if (typeof body.content !== "string") return json({ success: false, error: "missing content" }, { status: 400 });
			if (body.revision !== undefined && (typeof body.revision !== "string" || !/^(?:missing|[a-f0-9]{64})$/.test(body.revision))) {
				return json({ success: false, error: "invalid revision" }, { status: 400 });
			}
			await writeCustomProviders(body.content, body.revision);
			return json({ success: true, data: { requiresSessionReopen: false } });
		}
		if (body.action === "resolveCapabilities") {
			if (typeof body.revision !== "string" || !/^(?:missing|[a-f0-9]{64})$/.test(body.revision)) {
				return json({ success: false, error: "invalid revision" }, { status: 400 });
			}
			return json({ success: true, data: await resolveCustomModelCapabilities(body.revision) });
		}
		if (body.action === "discoverModels") {
			if (!body.baseUrl) return json({ success: false, error: "missing baseUrl" }, { status: 400 });
			// 自定义请求头来自表单：只接受「名字与值都是字符串」的键值对，条数与长度都要设上限，
			// 否则一个超大对象会原样发给上游。名字按 HTTP 令牌字符集收窄，避免注入换行等非法字符。
			let headers: Record<string, string> | undefined;
			if (body.headers !== undefined) {
				if (!body.headers || typeof body.headers !== "object" || Array.isArray(body.headers)) {
					return json({ success: false, error: "invalid headers" }, { status: 400 });
				}
				const entries = Object.entries(body.headers as Record<string, unknown>);
				if (entries.length > 32) return json({ success: false, error: "too many headers" }, { status: 400 });
				headers = {};
				for (const [name, value] of entries) {
					if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/.test(name) || name === "__proto__") {
						return json({ success: false, error: `invalid header name: ${name}` }, { status: 400 });
					}
					if (typeof value !== "string" || value.length > 4096 || /[\r\n]/.test(value)) {
						return json({ success: false, error: `invalid header value: ${name}` }, { status: 400 });
					}
					if (value) Object.defineProperty(headers, name, { value, enumerable: true, configurable: true, writable: true });
				}
			}
			const models = await discoverModels({ baseUrl: body.baseUrl, api: body.api, apiKey: body.apiKey, providerId: body.providerId, allowPrivate: body.allowPrivate === true, headers });
			return json({ success: true, data: { models } });
		}
		if (body.action === "providerUsage") {
			if (!body.providerId) return json({ success: false, error: "missing providerId" }, { status: 400 });
			const usage = await providerUsage(body.providerId, body.force === true);
			return json({ success: true, data: { usage } });
		}
		if (body.action === "contextWindowInfo" || body.action === "setContextWindow") {
			if (typeof body.providerId !== "string" || !body.providerId || typeof body.modelId !== "string" || !body.modelId) {
				return json({ success: false, error: "missing providerId or modelId" }, { status: 400 });
			}
			if (body.action === "contextWindowInfo") {
				return json({ success: true, data: await contextWindowInfo(body.providerId, body.modelId) });
			}
			if (typeof body.contextWindow !== "number") return json({ success: false, error: "missing contextWindow" }, { status: 400 });
			return json({ success: true, data: await setModelContextWindow(body.providerId, body.modelId, body.contextWindow) });
		}
		if (body.action === "thinkingProbe") {
			if (typeof body.providerId !== "string" || !body.providerId || typeof body.modelId !== "string" || !body.modelId) {
				return json({ success: false, error: "missing providerId or modelId" }, { status: 400 });
			}
			return json({ success: true, data: { report: await thinkingProbe(body.providerId, body.modelId) } });
		}
		if (body.action === "setThinkingLevelMap") {
			if (typeof body.providerId !== "string" || !body.providerId || typeof body.modelId !== "string" || !body.modelId) {
				return json({ success: false, error: "missing providerId or modelId" }, { status: 400 });
			}
			const map = validateThinkingLevelMap(body.thinkingLevelMap);
			if (!map) return json({ success: false, error: "invalid thinkingLevelMap" }, { status: 400 });
			return json({ success: true, data: await setModelThinkingLevelMap(body.providerId, body.modelId, map) });
		}
		if (body.action === "loginStart") {
			if (!body.providerId) return json({ success: false, error: "missing providerId" }, { status: 400 });
			await startLogin(body.providerId);
			return json({ success: true, data: publicLoginState(body.providerId) });
		}
		if (body.action === "loginState") {
			if (!body.providerId) return json({ success: false, error: "missing providerId" }, { status: 400 });
			return json({ success: true, data: publicLoginState(body.providerId) });
		}
		if (body.action === "loginAnswer") {
			if (!body.providerId || typeof body.text !== "string")
				return json({ success: false, error: "missing fields" }, { status: 400 });
			return json({ success: true, data: { delivered: answerLogin(body.providerId, body.text) } });
		}
		if (body.action === "loginCancel") {
			if (!body.providerId) return json({ success: false, error: "missing providerId" }, { status: 400 });
			cancelLogin(body.providerId);
			return json({ success: true });
		}
		return json({ success: false, error: "unknown action" }, { status: 400 });
	} catch (err: any) {
		const status = err instanceof CustomProvidersConflictError ? 409
			: err instanceof CustomProvidersValidationError || err instanceof BoundaryError || err instanceof SyntaxError ? 400 : 500;
		const failure = err instanceof CustomProvidersConflictError
			? { error: "模型配置已被其他修改更新，请重新载入后保存。", errorCode: "CONFIG_CHANGED" }
			: apiError(err, "模型操作失败，请检查配置、凭据和网络后重试。", status === 400);
		return json({ success: false, ...failure }, { status });
	}
}
