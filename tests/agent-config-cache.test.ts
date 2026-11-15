/**
 * L4：配置缓存必须有上限，不能按路径/工作区无限增长；正常规模下行为不变。
 * - agent-config：容量上限 + TTL（TTL 到期重新读盘，语义不变）；
 * - pi：SettingsManager / PackageManager 缓存按工作区增长，超限淘汰最早条目。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAgentConfigCacheStats, readJsonObject } from "@/lib/agent-config";
import { getPackageManager, getSettingsManager } from "@/lib/pi";
import { recycleTemporaryDirectory } from "@/lib/recycle-temporary";

const ENV_KEYS = ["PI_CODING_AGENT_DIR", "PIWEB_AGENT_CONFIG_CACHE_MAX", "PIWEB_AGENT_CONFIG_CACHE_TTL_MS", "PIWEB_PI_CACHE_MAX"] as const;
let previous: Record<string, string | undefined>;
let root: string;

beforeEach(async () => {
	previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
	root = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-config-cache-"));
	for (const key of ENV_KEYS) delete process.env[key];
	process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
});

afterEach(async () => {
	for (const key of ENV_KEYS) {
		if (previous[key] === undefined) delete process.env[key];
		else process.env[key] = previous[key];
	}
	vi.restoreAllMocks();
	await recycleTemporaryDirectory(root).catch(() => undefined);
});

describe("agent-config cache limits", () => {
	it("reports the configured limits to diagnostics", () => {
		expect(getAgentConfigCacheStats().maxEntries).toBe(512);
		expect(getAgentConfigCacheStats().ttlMs).toBe(30 * 60_000);
		process.env.PIWEB_AGENT_CONFIG_CACHE_MAX = "3";
		process.env.PIWEB_AGENT_CONFIG_CACHE_TTL_MS = "1000";
		expect(getAgentConfigCacheStats()).toMatchObject({ maxEntries: 3, ttlMs: 1000 });
	});

	it("never exceeds the configured capacity when reading many distinct files", async () => {
		process.env.PIWEB_AGENT_CONFIG_CACHE_MAX = "2";
		for (let index = 0; index < 6; index += 1) {
			const file = path.join(root, `config-${index}.json`);
			await fs.writeFile(file, JSON.stringify({ index }));
			await expect(readJsonObject(file)).resolves.toEqual({ index });
		}
		expect(getAgentConfigCacheStats().entries).toBeLessThanOrEqual(2);
	});

	it("re-reads after the TTL expires even when the file stamp is unchanged", async () => {
		const file = path.join(root, "ttl.json");
		await fs.writeFile(file, JSON.stringify({ value: 1 }));
		const readFile = vi.spyOn(fs, "readFile");
		await expect(readJsonObject(file)).resolves.toEqual({ value: 1 });
		const afterFirst = readFile.mock.calls.length;
		await expect(readJsonObject(file)).resolves.toEqual({ value: 1 });
		// 校验戳没变：第二次命中缓存，不读盘。
		expect(readFile.mock.calls.length).toBe(afterFirst);
		// TTL 到期后即使 stamp 不变也必须重新读盘（这里改写内容证明真的读了新文件）。
		process.env.PIWEB_AGENT_CONFIG_CACHE_TTL_MS = "1";
		await new Promise((resolve) => setTimeout(resolve, 10));
		await fs.writeFile(file, JSON.stringify({ value: 2 }));
		await expect(readJsonObject(file)).resolves.toEqual({ value: 2 });
		expect(readFile.mock.calls.length).toBeGreaterThan(afterFirst);
	});
});

describe("pi workspace caches stay bounded", () => {
	it("evicts the oldest SettingsManager when the configured limit is exceeded", async () => {
		process.env.PIWEB_PI_CACHE_MAX = "1";
		const first = path.join(root, "workspace-a");
		const second = path.join(root, "workspace-b");
		await fs.mkdir(first);
		await fs.mkdir(second);
		const original = getSettingsManager(first);
		getSettingsManager(second);
		// 容量 1：b 的插入淘汰 a；再取 a 必须重建实例（正常规模不会淘汰，行为不变）。
		expect(getSettingsManager(first)).not.toBe(original);
	});

	it("evicts the oldest PackageManager when the configured limit is exceeded", async () => {
		process.env.PIWEB_PI_CACHE_MAX = "1";
		const first = path.join(root, "pkg-a");
		const second = path.join(root, "pkg-b");
		await fs.mkdir(first);
		await fs.mkdir(second);
		const original = getPackageManager(first);
		getPackageManager(second);
		expect(getPackageManager(first)).not.toBe(original);
	});
});
