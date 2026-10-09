import fs from "node:fs/promises";
import path from "node:path";
import lockfile from "proper-lockfile";
import type { SettingsManager } from "@earendil-works/pi-coding-agent";

const pending = new Map<string, Promise<void>>();

/** Serialize in-process read/modify/write operations on the same Pi settings file. */
export function withSettingsWriteLock<T>(file: string, operation: () => Promise<T>): Promise<T> {
	const resolved = path.resolve(file);
	const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
	const previous = pending.get(key) ?? Promise.resolve();
	const result = previous.then(operation, operation);
	const settled = result.then(() => undefined, () => undefined);
	pending.set(key, settled);
	void settled.then(() => {
		if (pending.get(key) === settled) pending.delete(key);
	});
	return result;
}

/** Match the SDK's settings.json.lock protocol for PiWeb's manual JSON writes. */
export async function withExternalSettingsLock<T>(file: string, operation: () => Promise<T>): Promise<T> {
	await fs.mkdir(path.dirname(file), { recursive: true });
	const release = await lockfile.lock(file, {
		realpath: false,
		retries: { retries: 20, minTimeout: 20, maxTimeout: 100 },
	});
	try {
		return await operation();
	} finally {
		await release();
	}
}

/** SDK setters enqueue writes and record failures instead of rejecting flush(). */
export async function flushSettingsOrThrow(manager: Pick<SettingsManager, "flush" | "drainErrors">): Promise<void> {
	await manager.flush();
	const errors = manager.drainErrors();
	if (errors.length) {
		throw new Error(`Pi settings failed: ${errors.map(({ scope, error }) => `${scope}: ${error.message}`).join("; ")}`, {
			cause: errors[0].error,
		});
	}
}
