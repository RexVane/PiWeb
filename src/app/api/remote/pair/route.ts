import { NextResponse } from "next/server";
import { PairingError, refreshPairCode } from "@/lib/remote/pairing";
import { refreshPublicStatus, remoteBlocked, remoteStatus } from "@/lib/remote/supervisor";
import { authEnabled } from "@/lib/web-auth";
import { loadSessionRevocations } from "@/lib/web-secret";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };

/**
 * 发一个一次性配对码，并给出可直接扫的地址。
 *
 * 调用方是已登录的设置页（本机），所以这里只做「哪种入口」的选择，不做额外鉴权。
 * 默认统一使用可从本地网络和外网访问的地址，必须已经 running 且 DNS 生效。
 * base=lan 仅保留给旧 API 调用方；新界面不发局域网专用码。
 */
export async function POST(request: Request) {
	if (!authEnabled()) {
		return NextResponse.json({ success: false, error: "authentication is disabled" }, { status: 409, headers: NO_STORE });
	}
	const blocked = remoteBlocked();
	if (blocked) {
		return NextResponse.json({ success: false, error: `remote entries are blocked: ${blocked}` }, { status: 409, headers: NO_STORE });
	}

	let base: "lan" | "public" = "public";
	let previousCode: unknown;
	try {
		const body = (await request.json()) as { base?: unknown; previousCode?: unknown };
		if (body?.base === "public" || body?.base === "lan") base = body.base;
		previousCode = body?.previousCode;
	} catch {
		/* 没有 body 就使用统一连接地址 */
	}

	if (base !== "lan") await refreshPublicStatus();
	const status = remoteStatus();
	const publicReady = status.public.running && status.public.ready && Boolean(status.public.url);
	const selected = base;
	const origin = selected === "public" ? (publicReady ? status.public.url : null) : (status.lan.running ? status.lan.urls[0] ?? null : null);
	if (!origin) {
		return NextResponse.json(
			{ success: false, error: selected === "public" ? "public entry is not ready yet" : "lan entry is not running" },
			{ status: 409, headers: NO_STORE },
		);
	}

	try {
		const revocations = loadSessionRevocations();
		if (revocations.unavailable) return NextResponse.json({ success: false, error: "session authentication is temporarily unavailable" }, { status: 503, headers: NO_STORE });
		const { code, expiresAt } = refreshPairCode(previousCode, Date.now(), revocations.notBefore);
		const url = `${origin.replace(/\/+$/, "")}/pair?code=${code}`;
		return NextResponse.json({ success: true, data: { code, url, expiresAt, remainingMs: Math.max(0, expiresAt - Date.now()), base: selected } }, { headers: NO_STORE });
	} catch (error) {
		const reason = error instanceof PairingError ? error.reason : "pairing failed";
		return NextResponse.json({ success: false, error: reason }, { status: 429, headers: { ...NO_STORE, "Retry-After": "15" } });
	}
}
