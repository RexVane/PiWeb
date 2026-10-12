import { gzipSync } from "node:zlib";
import { NextResponse } from "next/server";
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
	loginState,
	modelListStamp,
	providerUsage,
	readCustomProviders,
	removeApiKey,
	setApiKey,
	setModelContextWindow,
	startLogin,
	writeCustomProviders,
} from "@/lib/models-service";

export const dynamic = "force-dynamic";

/**
 * 完整目录 482KB、精简目录 271KB，未压缩发送太浪费；这里自己 gzip。
 * gzip 是主线程同步操作，设置面板开关一次会连着请求好几次，所以按目录版本戳复用压好的字节：
 * 目录没变（5 秒 TTL 内、且没人改配置）就不再重新压一遍。
 */
const gzipCache = new Map<string, { at: number; body: Uint8Array }>();
const GZIP_CACHE_TTL_MS = 5_000;

function jsonMaybeGzip(req: Request, payload: unknown, stamp: string): Response {
	const body = JSON.stringify(payload);
	const accept = req.headers.get("accept-encoding") ?? "";
	const headers = { "Content-Type": "application/json; charset=utf-8", Vary: "Accept-Encoding", "Cache-Control": "no-store" };
	if (!/\bgzip\b/.test(accept) || body.length < 2048) return new Response(body, { headers });
	const key = `${stamp}:${body.length}`;
	const cached = gzipCache.get(key);
	if (cached && Date.now() - cached.at < GZIP_CACHE_TTL_MS) {
		return new Response(cached.body.slice(), { headers: { ...headers, "Content-Encoding": "gzip" } });
	}
	const gz = new Uint8Array(gzipSync(Buffer.from(body, "utf8")));
	if (gzipCache.size > 8) gzipCache.clear();
	gzipCache.set(key, { at: Date.now(), body: gz });
	return new Response(gz.slice(), { headers: { ...headers, "Content-Encoding": "gzip" } });
}

export async function GET(req: Request) {
	const params = new URL(req.url).searchParams;
	const custom = params.get("custom") === "1";
	const full = custom || params.get("full") === "1";
	try {
		const customProviders = custom ? await readCustomProviders() : null;
		const data = await (full ? listModels() : listModelsForPiWeb());
		// 页面挂载只需要选模型用的字段（1300+ 个模型带 api/baseUrl/cost/input 有 400KB）；设置页用 custom=1 拿完整版
		const models = full
			? data.models
			: data.models.map((m) => ({ provider: m.provider, id: m.id, name: m.name, reasoning: m.reasoning, thinkingLevels: m.thinkingLevels, contextWindow: m.contextWindow }));
		const providers = full
			? data.providers
			: data.providers.map((p) => ({ id: p.id, name: p.name, authReady: p.authReady, builtIn: p.builtIn, modelCount: p.modelCount }));
		// 设置页编辑内置 provider 时据此把「覆盖已有模型」写进 modelOverrides，而不是 models[]
		const catalogModelIds = customProviders ? await builtinCatalogModelIds(customProviders.content, data.models) : undefined;
		return jsonMaybeGzip(
			req,
			{ success: true, data: { providers, models, customProviders, ...(catalogModelIds ? { catalogModelIds } : {}) } },
			`${modelListStamp()}:${custom ? "custom" : full ? "full" : "piweb"}`,
		);
	} catch (err: any) {
		return NextResponse.json({ success: false, error: String(err?.message ?? err) }, { status: 500 });
	}
}

export async function POST(req: Request) {
	try {
		const body = (await req.json()) as {
			action:
				| "setKey"
				| "removeKey"
				| "saveCustomProviders"
				| "discoverModels"
				| "providerUsage"
				| "contextWindowInfo"
				| "setContextWindow"
				| "loginStart"
				| "loginState"
				| "loginAnswer"
				| "loginCancel";
			providerId?: string;
			modelId?: string;
			contextWindow?: number;
			apiKey?: string;
			baseUrl?: string;
			api?: string;
			content?: string;
			revision?: string;
			text?: string;
			force?: boolean;
			allowPrivate?: boolean;
		};
		if (body.action === "setKey") {
			if (!body.providerId || !body.apiKey) return NextResponse.json({ success: false, error: "missing fields" }, { status: 400 });
			await setApiKey(body.providerId, body.apiKey);
			return NextResponse.json({ success: true });
		}
		if (body.action === "removeKey") {
			if (!body.providerId) return NextResponse.json({ success: false, error: "missing providerId" }, { status: 400 });
			await removeApiKey(body.providerId);
			return NextResponse.json({ success: true });
		}
		if (body.action === "saveCustomProviders") {
			if (typeof body.content !== "string") return NextResponse.json({ success: false, error: "missing content" }, { status: 400 });
			if (body.revision !== undefined && (typeof body.revision !== "string" || !/^(?:missing|[a-f0-9]{64})$/.test(body.revision))) {
				return NextResponse.json({ success: false, error: "invalid revision" }, { status: 400 });
			}
			await writeCustomProviders(body.content, body.revision);
			return NextResponse.json({ success: true, data: { requiresSessionReopen: true } });
		}
		if (body.action === "discoverModels") {
			if (!body.baseUrl) return NextResponse.json({ success: false, error: "missing baseUrl" }, { status: 400 });
			const models = await discoverModels({ baseUrl: body.baseUrl, api: body.api, apiKey: body.apiKey, providerId: body.providerId, allowPrivate: body.allowPrivate === true });
			return NextResponse.json({ success: true, data: { models } });
		}
		if (body.action === "providerUsage") {
			if (!body.providerId) return NextResponse.json({ success: false, error: "missing providerId" }, { status: 400 });
			const usage = await providerUsage(body.providerId, body.force === true);
			return NextResponse.json({ success: true, data: { usage } });
		}
		if (body.action === "contextWindowInfo" || body.action === "setContextWindow") {
			if (typeof body.providerId !== "string" || !body.providerId || typeof body.modelId !== "string" || !body.modelId) {
				return NextResponse.json({ success: false, error: "missing providerId or modelId" }, { status: 400 });
			}
			if (body.action === "contextWindowInfo") {
				return NextResponse.json({ success: true, data: await contextWindowInfo(body.providerId, body.modelId) });
			}
			if (typeof body.contextWindow !== "number") return NextResponse.json({ success: false, error: "missing contextWindow" }, { status: 400 });
			return NextResponse.json({ success: true, data: await setModelContextWindow(body.providerId, body.modelId, body.contextWindow) });
		}
		if (body.action === "loginStart") {
			if (!body.providerId) return NextResponse.json({ success: false, error: "missing providerId" }, { status: 400 });
			await startLogin(body.providerId);
			return NextResponse.json({ success: true, data: loginState(body.providerId) });
		}
		if (body.action === "loginState") {
			if (!body.providerId) return NextResponse.json({ success: false, error: "missing providerId" }, { status: 400 });
			return NextResponse.json({ success: true, data: loginState(body.providerId) });
		}
		if (body.action === "loginAnswer") {
			if (!body.providerId || typeof body.text !== "string")
				return NextResponse.json({ success: false, error: "missing fields" }, { status: 400 });
			return NextResponse.json({ success: true, data: { delivered: answerLogin(body.providerId, body.text) } });
		}
		if (body.action === "loginCancel") {
			if (!body.providerId) return NextResponse.json({ success: false, error: "missing providerId" }, { status: 400 });
			cancelLogin(body.providerId);
			return NextResponse.json({ success: true });
		}
		return NextResponse.json({ success: false, error: "unknown action" }, { status: 400 });
	} catch (err: any) {
		const status = err instanceof CustomProvidersConflictError ? 409
			: err instanceof CustomProvidersValidationError || err instanceof SyntaxError ? 400 : 500;
		return NextResponse.json({ success: false, error: String(err?.message ?? err) }, { status });
	}
}
