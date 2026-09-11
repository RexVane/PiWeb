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

export async function GET(req: Request) {
	const custom = new URL(req.url).searchParams.get("custom") === "1";
	try {
		const data = await listModels();
		const customProviders = custom ? await readCustomProviders() : null;
		return NextResponse.json({ success: true, data: { ...data, customProviders } });
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
