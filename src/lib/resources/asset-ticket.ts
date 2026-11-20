import { createHmac, timingSafeEqual } from "node:crypto";
import type { SessionCookiePayload, SessionRevocationList } from "../web-auth";

interface AssetTicket {
	version: 1;
	view: string;
	authority: string;
	issuedAt: number;
	expiresAt: number;
	cookieId: string;
	cookieIssuedAt: number;
	revocationEpoch?: number;
}
const MAX_AGE = 60 * 60_000;
const mac = (data: string, secret: Buffer) => createHmac("sha256", secret).update("piweb-resource-assets/v1\n").update(data).digest("base64url");

/** A capability only for one declared view's static asset namespace, never an API or OS permission. */
export function createResourceAssetTicket(view: string, cookie: { id: string; payload: SessionCookiePayload }, secret: Buffer, now = Date.now()): string {
	const payload: AssetTicket = { version: 1, view, authority: cookie.payload.authority, issuedAt: now, expiresAt: Math.min(now + MAX_AGE, cookie.payload.expiresAt),
		cookieId: cookie.id, cookieIssuedAt: cookie.payload.issuedAt, revocationEpoch: cookie.payload.revocationEpoch };
	const data = JSON.stringify(payload);
	return Buffer.from(JSON.stringify({ data, signature: mac(data, secret) })).toString("base64url");
}

export function resourceAssetTicketView(token: string, authority: string | undefined, secret: Buffer, revocations: SessionRevocationList, now = Date.now()): string | undefined {
	try {
		if (!authority || revocations.unavailable || typeof token !== "string" || token.length > 24_000 || !/^[\w-]+$/.test(token)) return undefined;
		const envelope = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
		if (typeof envelope.data !== "string" || typeof envelope.signature !== "string") return undefined;
		const expected = Buffer.from(mac(envelope.data, secret)); const actual = Buffer.from(envelope.signature);
		if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return undefined;
		const payload = JSON.parse(envelope.data) as AssetTicket;
		if (payload.version !== 1 || payload.authority !== authority || typeof payload.view !== "string" || payload.view.length > 12_000 || !/^[\w-]+$/.test(payload.view)
			|| !Number.isFinite(payload.issuedAt) || !Number.isFinite(payload.expiresAt) || payload.issuedAt > now || payload.expiresAt <= now
			|| payload.expiresAt <= payload.issuedAt || payload.expiresAt - payload.issuedAt > MAX_AGE || typeof payload.cookieId !== "string" || !Number.isFinite(payload.cookieIssuedAt)) return undefined;
		if ((payload.revocationEpoch === undefined ? payload.cookieIssuedAt < revocations.notBefore : payload.revocationEpoch !== revocations.notBefore) || revocations.revoked.has(payload.cookieId)) return undefined;
		return payload.view;
	} catch { return undefined; }
}

export function resourceAssetPathToken(pathname: string): string | undefined {
	return /^\/api\/resources\/views\/([A-Za-z0-9_-]+)\/assets\/[A-Za-z0-9._%/-]+$/.exec(pathname)?.[1];
}
