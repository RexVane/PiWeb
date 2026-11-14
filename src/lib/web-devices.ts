import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { agentDir, loadSessionRevocations } from "./web-secret";
import { replaceFileAtomically } from "./atomic-file";
import { readFileBounded } from "./read-file-bounded";
import { withSettingsWriteLock, withExternalSettingsLock } from "./settings-write-lock";
import type { SessionCookiePayload } from "./web-auth";

export interface WebDevice { id: string; createdAt: number; lastSeenAt: number; expiresAt: number; deviceType: string; revocationEpoch?: number }
const seen = new Map<string, number>();
const pending = new Set<Promise<void>>();
const file = () => path.join(agentDir(), "web-devices.json");
async function read(): Promise<WebDevice[]> {
	try {
		const parsed = JSON.parse((await readFileBounded(file(), 1024 * 1024)).toString("utf8"));
		if (!Array.isArray(parsed)) throw new Error("invalid device registry");
		return parsed.filter((device): device is WebDevice => typeof device?.id === "string" && Number.isFinite(device.createdAt) && Number.isFinite(device.expiresAt)
			&& Number.isFinite(device.lastSeenAt) && typeof device.deviceType === "string");
	} catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}
async function writeWebDevice(id: string, payload: SessionCookiePayload): Promise<void> {
	const now = Date.now(); const key = `${file()}:${id}`;
	if ((seen.get(key) ?? 0) + 60_000 > now) return;
	seen.set(key, now);
	if (seen.size > 1000) for (const [storedKey, storedAt] of seen) { if (storedAt < now - 60_000) seen.delete(storedKey); }
	while (seen.size > 1000) seen.delete(seen.keys().next().value!);
	const target = file();
	try { await withSettingsWriteLock(target, () => withExternalSettingsLock(target, async () => {
		const records = (await read()).filter((device) => device.expiresAt > now && device.id !== id);
		records.push({ id, createdAt: payload.issuedAt, lastSeenAt: now, expiresAt: payload.expiresAt, deviceType: payload.deviceType ?? "浏览器", ...(payload.revocationEpoch === undefined ? {} : { revocationEpoch: payload.revocationEpoch }) });
		const temporary = `${target}.${randomUUID()}.tmp`;
		try { await fs.writeFile(temporary, JSON.stringify(records.slice(-200)), { flag: "wx", mode: 0o600 }); await replaceFileAtomically(temporary, target); }
		finally { await fs.unlink(temporary).catch(() => undefined); }
	})); } catch (error) {
		if (seen.get(key) === now) seen.delete(key);
		throw error;
	}
}
export function rememberWebDevice(id: string, payload: SessionCookiePayload): Promise<void> {
	const write = writeWebDevice(id, payload); pending.add(write);
	void write.finally(() => pending.delete(write)).catch(() => undefined);
	return write;
}
export async function flushWebDevices(): Promise<void> { await Promise.allSettled([...pending]); }
export async function listWebDevices(): Promise<WebDevice[]> {
	await flushWebDevices();
	const revocations = loadSessionRevocations(); const now = Date.now();
	return (await read()).filter((device) => device.expiresAt > now
		&& (device.revocationEpoch === undefined ? device.createdAt >= revocations.notBefore : device.revocationEpoch === revocations.notBefore)
		&& !revocations.revoked.has(device.id))
		.sort((left, right) => right.lastSeenAt - left.lastSeenAt);
}
