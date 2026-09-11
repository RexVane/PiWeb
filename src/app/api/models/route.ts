import { gzipSync } from "node:zlib";
import { NextResponse } from "next/server";
import {
	answerLogin,
	cancelLogin,
	discoverModels,
	listModels,
	loginState,
	readCustomProviders,
	removeApiKey,
	setApiKey,
	startLogin,
	writeCustomProviders,
} from "@/lib/models-service";

export const dynamic = "force-dynamic";

/** 1300+ 个模型的目录有 240KB～420KB；Next 的压缩层实测没有压这条响应，这里自己 gzip（浏览器透明解压） */
function jsonMaybeGzip(req: Request, payload: unknown): Response {
	const body = JSON.stringify(payload);
	const accept = req.headers.get("accept-encoding") ?? "";
	if (!/\bgzip\b/.test(accept) || body.length < 2048) {
		return new Response(body, { headers: { "Content-Type": "application/json; charset=utf-8" } });
	}
	const gz = gzipSync(Buffer.from(body, "utf8"));
	return new Response(new Uint8Array(gz), {
		headers: { "Content-Type": "application/json; charset=utf-8", "Content-Encoding": "gzip", Vary: "Accept-Encoding", "Cache-Control": "no-store" },
	});
}

export async function GET(req: Request) {
	const params = new URL(req.url).searchParams;
	const custom = params.get("custom") === "1";
	const full = custom || params.get("full") === "1";
	try {
		const data = await listModels();
		const customProviders = custom ? await readCustomProviders() : null;
		// 页面挂载只需要选模型用的字段（1300+ 个模型带 api/baseUrl/cost/input 有 400KB）；设置页用 custom=1 拿完整版
		const models = full
			? data.models
			: data.models.map((m) => ({ provider: m.provider, id: m.id, name: m.name, reasoning: m.reasoning, thinkingLevels: m.thinkingLevels, contextWindow: m.contextWindow }));
		const providers = full
			? data.providers
			: data.providers.map((p) => ({ id: p.id, name: p.name, authReady: p.authReady, builtIn: p.builtIn, modelCount: p.modelCount }));
		return jsonMaybeGzip(req, { success: true, data: { providers, models, customProviders } });
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
				| "loginStart"
				| "loginState"
				| "loginAnswer"
				| "loginCancel";
			providerId?: string;
			apiKey?: string;
			baseUrl?: string;
			api?: string;
			content?: string;
			text?: string;
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
			await writeCustomProviders(body.content);
			return NextResponse.json({ success: true, data: { requiresSessionReopen: true } });
		}
		if (body.action === "discoverModels") {
			if (!body.baseUrl) return NextResponse.json({ success: false, error: "missing baseUrl" }, { status: 400 });
			const models = await discoverModels({ baseUrl: body.baseUrl, api: body.api, apiKey: body.apiKey, providerId: body.providerId });
			return NextResponse.json({ success: true, data: { models } });
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
		return NextResponse.json({ success: false, error: String(err?.message ?? err) }, { status: 500 });
	}
}
