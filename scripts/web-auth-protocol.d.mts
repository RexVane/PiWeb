export const COOKIE_PREFIX: "piweb_session_";
export const SESSION_MAX_AGE_SECONDS: number;
export interface SessionCookiePayload { version: 1; authority: string; issuedAt: number; expiresAt: number; sessionId?: string; deviceType?: string; revocationEpoch?: number }
export function launchTokenIpcPath(agentRoot: string, port: number | string): string;
export function launchIpcProof(token: string, stage: "server" | "client" | "ready", clientNonce: string, serverNonce: string): string;
export function validLaunchIpcProof(proof: unknown, token: string, stage: "server" | "client" | "ready", clientNonce: string, serverNonce: string): boolean;
export function cookieNameForAuthority(authority: string): string;
export function sessionCookieId(raw: string): string;
export function encodeSessionCookie(payload: SessionCookiePayload, secret: Buffer): string;
export function decodeSessionCookie(raw: string, secret: Buffer): SessionCookiePayload | undefined;
export function validCookieValue(raw: string, authority: string, secret: Buffer, now?: number, revocations?: {notBefore: number; revoked: ReadonlyMap<string, number>}): boolean;
