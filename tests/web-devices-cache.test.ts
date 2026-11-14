import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SessionCookiePayload } from "@/lib/web-auth";

// Keep JSON serialization and the device service real. A small in-memory filesystem
// avoids a thousand filesystem locks solely to exercise the request-coalescing cache.
const disk = vi.hoisted(() => ({ files: new Map<string, string>(), writes: 0 }));
vi.mock("@/lib/web-secret", () => ({ agentDir: () => "/piweb-cache-fixture", loadSessionRevocations: () => ({ notBefore: 0, revoked: new Set<string>() }) }));
vi.mock("@/lib/settings-write-lock", () => ({
	withSettingsWriteLock: (_file: string, operation: () => Promise<unknown>) => operation(),
	withExternalSettingsLock: (_file: string, operation: () => Promise<unknown>) => operation(),
}));
vi.mock("@/lib/read-file-bounded", () => ({ readFileBounded: async (file: string, maximum: number) => {
	const contents = disk.files.get(file);
	if (contents === undefined) throw Object.assign(new Error("missing fixture file"), { code: "ENOENT" });
	if (Buffer.byteLength(contents) > maximum) throw new Error("size limit");
	return Buffer.from(contents);
} }));
vi.mock("node:fs/promises", () => ({ default: {
	writeFile: async (file: string, contents: string, options?: { flag?: string }) => {
		if (options?.flag === "wx" && disk.files.has(file)) throw Object.assign(new Error("fixture file exists"), { code: "EEXIST" });
		disk.files.set(file, contents); disk.writes++;
	},
	unlink: async (file: string) => { disk.files.delete(file); },
} }));
vi.mock("@/lib/atomic-file", () => ({ replaceFileAtomically: async (source: string, destination: string) => {
	const contents = disk.files.get(source);
	if (contents === undefined) throw new Error("missing fixture temporary file");
	disk.files.set(destination, contents); disk.files.delete(source);
} }));

beforeEach(() => { disk.files.clear(); disk.writes = 0; vi.resetModules(); });
afterEach(() => { vi.restoreAllMocks(); });

it("persists an evicted device again within one minute while still coalescing recently seen devices", async () => {
	const { rememberWebDevice, listWebDevices } = await import("@/lib/web-devices");
	const now = 1_800_000_000_000;
	const clock = vi.spyOn(Date, "now").mockReturnValue(now);
	const payload = { version: 1, authority: "localhost:2516", issuedAt: now, expiresAt: now + 600_000, deviceType: "fixture" } as SessionCookiePayload;
	await rememberWebDevice("first", payload);
	for (let index = 1; index <= 1000; index++) await rememberWebDevice(`recent-${index}`, payload);
	const afterChurn = disk.writes;
	expect((await listWebDevices()).some((device) => device.id === "first")).toBe(false);
	clock.mockReturnValue(now + 1_000);
	await rememberWebDevice("recent-1000", payload);
	expect(disk.writes).toBe(afterChurn);
	await rememberWebDevice("first", payload);
	expect(disk.writes).toBe(afterChurn + 1);
	const records = JSON.parse(disk.files.get(path.join("/piweb-cache-fixture", "web-devices.json"))!);
	expect(records.find((device: { id: string }) => device.id === "first")).toMatchObject({ lastSeenAt: now + 1_000, deviceType: "fixture" });
	expect(records).toHaveLength(200);
	expect(disk.files.size).toBe(1);
});
