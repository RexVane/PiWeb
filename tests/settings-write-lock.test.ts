import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	SettingsWriteBusyError,
	isRetryableSettingsWriteError,
	withExternalSettingsLock,
	withSettingsWriteLock,
} from "../src/lib/settings-write-lock";

function codedError(code: string): NodeJS.ErrnoException {
	return Object.assign(new Error(`simulated ${code}`), { code });
}

const roots: string[] = [];
async function tempRoot(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-settings-lock-"));
	roots.push(root);
	return root;
}

afterEach(async () => {
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("withSettingsWriteLock", () => {
	it("serializes concurrent writers on the same file", async () => {
		const file = path.join(await tempRoot(), "settings.json");
		const events: string[] = [];
		const first = withSettingsWriteLock(file, async () => {
			events.push("a-start");
			await new Promise((resolve) => setTimeout(resolve, 25));
			events.push("a-end");
		});
		const second = withSettingsWriteLock(file, async () => {
			events.push("b-start");
			events.push("b-end");
		});
		await Promise.all([first, second]);
		expect(events).toEqual(["a-start", "a-end", "b-start", "b-end"]);
	});

	it("does not retry by default: a locked write still rejects immediately", async () => {
		const file = path.join(await tempRoot(), "settings.json");
		let attempts = 0;
		await expect(withSettingsWriteLock(file, async () => {
			attempts += 1;
			throw codedError("EACCES");
		})).rejects.toMatchObject({ code: "EACCES" });
		expect(attempts).toBe(1);
	});

	it("retryBusy retries transient Windows lock errors and then succeeds", async () => {
		const file = path.join(await tempRoot(), "settings.json");
		let attempts = 0;
		await withSettingsWriteLock(file, async () => {
			attempts += 1;
			if (attempts < 3) throw codedError(attempts === 1 ? "EACCES" : "ELOCKED");
		}, { retryBusy: true });
		expect(attempts).toBe(3);
	});

	it("retryBusy maps exhausted lock conflicts to SettingsWriteBusyError", async () => {
		const file = path.join(await tempRoot(), "settings.json");
		let attempts = 0;
		const error = await withSettingsWriteLock(file, async () => {
			attempts += 1;
			throw codedError("EACCES");
		}, { retryBusy: true, attempts: 3 }).catch((err: unknown) => err);
		expect(attempts).toBe(3);
		expect(error).toBeInstanceOf(SettingsWriteBusyError);
		expect((error as SettingsWriteBusyError).code).toBe("SETTINGS_BUSY");
		expect((error as SettingsWriteBusyError).retryAfterSeconds).toBe(1);
	});

	it("retryBusy does not swallow non-lock failures", async () => {
		const file = path.join(await tempRoot(), "settings.json");
		let attempts = 0;
		await expect(withSettingsWriteLock(file, async () => {
			attempts += 1;
			throw codedError("ENOENT");
		}, { retryBusy: true })).rejects.toMatchObject({ code: "ENOENT" });
		expect(attempts).toBe(1);
	});
});

describe("isRetryableSettingsWriteError", () => {
	it("treats Windows/portable lock contention codes as retryable", () => {
		for (const code of ["EACCES", "EPERM", "ELOCKED", "EBUSY"]) expect(isRetryableSettingsWriteError(codedError(code)), code).toBe(true);
		for (const code of ["ENOENT", "ENOTDIR", "EINVAL"]) expect(isRetryableSettingsWriteError(codedError(code)), code).toBe(false);
		expect(isRetryableSettingsWriteError(new Error("plain"))).toBe(false);
		expect(isRetryableSettingsWriteError(undefined)).toBe(false);
	});
});

describe("withExternalSettingsLock", () => {
	it("runs the operation under a real lock and releases it afterwards", async () => {
		const file = path.join(await tempRoot(), "state.json");
		await fs.writeFile(file, "{}");
		await withExternalSettingsLock(file, async () => {
			await fs.writeFile(file, JSON.stringify({ written: true }));
		});
		expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({ written: true });
		// 锁已释放：第二次获取不会被挡住
		await expect(withExternalSettingsLock(file, async () => "again")).resolves.toBe("again");
	});

	it("releases the lock when the operation throws", async () => {
		const file = path.join(await tempRoot(), "state.json");
		await fs.writeFile(file, "{}");
		await expect(withExternalSettingsLock(file, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
		await expect(withExternalSettingsLock(file, async () => "ok")).resolves.toBe("ok");
	});
});
