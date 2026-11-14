import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import path from "node:path";
import fs from "node:fs";

/** Local-only login refresh; the request still needs the private token file. */
export function launchTokenIpcPath(agentRoot, port) {
	let root = path.resolve(agentRoot);
	try { root = fs.realpathSync(root); } catch { /* A first launch may not have created this directory yet. */ }
	if (process.platform === "win32") root = root.toLowerCase();
	return process.platform === "win32"
		? `\\\\.\\pipe\\piweb-launch-${createHash("sha256").update(`${root}:${port}`).digest("hex").slice(0, 32)}`
		: path.join(root, "web-launch", `${port}.socket`);
}

import { COOKIE_PREFIX, SESSION_MAX_AGE_SECONDS } from "./web-auth-constants.mjs";
export { COOKIE_PREFIX, SESSION_MAX_AGE_SECONDS };

/** Challenge proofs never expose the file credential to an impersonated pipe. */
export function launchIpcProof(token, stage, clientNonce, serverNonce) {
	return createHmac("sha256", token).update(JSON.stringify(["piweb-launch-ipc-v2", stage, clientNonce, serverNonce])).digest("base64url");
}
export function validLaunchIpcProof(proof, token, stage, clientNonce, serverNonce) {
	if (typeof proof !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(proof)) return false;
	const expected = launchIpcProof(token, stage, clientNonce, serverNonce);
	return timingSafeEqual(Buffer.from(proof), Buffer.from(expected));
}
export function cookieNameForAuthority(authority) {
	return COOKIE_PREFIX + createHash("sha256").update(authority).digest("base64url");
}
export function sessionCookieId(raw) { return createHash("sha256").update(raw).digest("base64url"); }
function decode(value) {
	if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) return undefined;
	const bytes = Buffer.from(value, "base64url");
	return bytes.toString("base64url") === value ? bytes : undefined;
}
export function encodeSessionCookie(payload, secret) {
	const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
	return `v1.${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
}
export function decodeSessionCookie(raw, secret) {
	if (typeof raw !== "string" || raw.length > 4096) return undefined;
	const parts = raw.split(".");
	if (parts.length !== 3 || parts[0] !== "v1") return undefined;
	const signature = decode(parts[2]);
	const expected = createHmac("sha256", secret).update(parts[1]).digest();
	if (!signature || signature.length !== expected.length || !timingSafeEqual(signature, expected)) return undefined;
	const body = decode(parts[1]);
	if (!body) return undefined;
	try {
		const payload = JSON.parse(body.toString("utf8"));
		if (!payload || Array.isArray(payload) || payload.version !== 1 || typeof payload.authority !== "string"
			|| !Number.isSafeInteger(payload.issuedAt) || !Number.isSafeInteger(payload.expiresAt)
			|| (payload.revocationEpoch !== undefined && (!Number.isSafeInteger(payload.revocationEpoch) || payload.revocationEpoch < 0))) return undefined;
		return payload;
	} catch { return undefined; }
}
export function validCookieValue(raw, authority, secret, now = Date.now(), revocations) {
	const payload = decodeSessionCookie(raw, secret);
	return Boolean(payload && payload.authority === authority && payload.issuedAt <= now && payload.expiresAt > now
		&& payload.expiresAt > payload.issuedAt && payload.expiresAt - payload.issuedAt <= SESSION_MAX_AGE_SECONDS * 1000
		&& (!revocations || ((payload.revocationEpoch === undefined ? payload.issuedAt >= revocations.notBefore : payload.revocationEpoch === revocations.notBefore) && !revocations.revoked.has(sessionCookieId(raw)))));
}
