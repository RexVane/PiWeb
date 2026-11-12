import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import lockfile from "proper-lockfile";
import { describe, expect, it, vi } from "vitest";
import { getEnabledModelPatterns, getPiSettings, patchPiSettings, validatePiSettingsPatch } from "../src/lib/pi-settings";
import { withSettingsWriteLock } from "../src/lib/settings-write-lock";

describe("Pi settings patches", () => {
	it("accepts typed, non-negative settings", () => {
		expect(validatePiSettingsPatch({ compaction: { reserveTokens: 0 }, retry: { enabled: false, maxRetries: 5 } })).toEqual({
			compaction: { reserveTokens: 0 },
			retry: { enabled: false, maxRetries: 5 },
		});
	});

	it("rejects invalid types and out-of-range values before writing", () => {
		expect(() => validatePiSettingsPatch({ retry: { maxRetries: "5" } })).toThrow();
		expect(() => validatePiSettingsPatch({ retry: { maxRetries: -1 } })).toThrow();
		expect(() => validatePiSettingsPatch({ compaction: { enabled: "true" } })).toThrow();
		expect(() => validatePiSettingsPatch({ unexpected: true })).toThrow();
	});
});

it("reads Pi's enabledModels patterns for the model picker", async () => {
	const previous = process.env.PI_CODING_AGENT_DIR;
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-settings-model-scope-"));
	try {
		process.env.PI_CODING_AGENT_DIR = agentDir;
		await fs.writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ enabledModels: ["openai-codex/gpt-6-*", "gpt-6.1-sol"] }));
		expect(await getEnabledModelPatterns()).toEqual(["openai-codex/gpt-6-*", "gpt-6.1-sol"]);
		await fs.writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ theme: "dark" }));
		expect(await getEnabledModelPatterns()).toBeNull();
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		await fs.rm(agentDir, { recursive: true, force: true });
	}
});

it("serializes settings writes for the same path", async () => {
	const order: string[] = [];
	const file = "piweb-test-settings.json";
	await Promise.all([
		withSettingsWriteLock(file, async () => {
			order.push("first start");
			await new Promise((resolve) => setTimeout(resolve, 10));
			order.push("first end");
		}),
		withSettingsWriteLock(file, async () => {
			order.push("second");
		}),
	]);
	expect(order).toEqual(["first start", "first end", "second"]);
});

it("preserves unrelated fields and refuses to overwrite malformed settings", async () => {
	const previous = process.env.PI_CODING_AGENT_DIR;
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-settings-"));
	const file = path.join(agentDir, "settings.json");
	try {
		process.env.PI_CODING_AGENT_DIR = agentDir;
		await fs.writeFile(file, JSON.stringify({ theme: "dark", retry: { provider: "custom", maxRetries: 2 } }));
		await patchPiSettings({ retry: { maxRetries: 5 } });
		expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({ theme: "dark", retry: { provider: "custom", maxRetries: 5 } });

		await fs.writeFile(file, "{broken json");
		await expect(getPiSettings()).rejects.toThrow();
		await expect(patchPiSettings({ retry: { maxRetries: 3 } })).rejects.toThrow();
		expect(await fs.readFile(file, "utf8")).toBe("{broken json");
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		await fs.rm(agentDir, { recursive: true, force: true });
	}
});

it("re-reads settings.json inside the write lock even when the cache stamp did not change", async () => {
	// 回归：读-改-写走了校验戳缓存；pi 自己写文件不会作废它，同一时刻的等长写入戳不变，
	// 于是拿旧内容合并、把 pi 刚写的字段盖了回去
	const previous = process.env.PI_CODING_AGENT_DIR;
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-settings-stale-"));
	const file = path.join(agentDir, "settings.json");
	const realStat = fs.stat.bind(fs);
	try {
		process.env.PI_CODING_AGENT_DIR = agentDir;
		await fs.writeFile(file, JSON.stringify({ theme: "dark" }));
		await getPiSettings();
		const frozen = await realStat(file);
		vi.spyOn(fs, "stat").mockImplementation(async (target, ...rest) => (target === file ? frozen : realStat(target, ...rest)) as never);
		await fs.writeFile(file, JSON.stringify({ theme: "lite" }));
		await patchPiSettings({ retry: { maxRetries: 4 } });
		expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({ theme: "lite", retry: { maxRetries: 4 } });
	} finally {
		vi.restoreAllMocks();
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		await fs.rm(agentDir, { recursive: true, force: true });
	}
});

it("waits for the same cross-process lock used by Pi", async () => {
	const previous = process.env.PI_CODING_AGENT_DIR;
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-settings-lock-"));
	const file = path.join(agentDir, "settings.json");
	let release: (() => Promise<void>) | undefined;
	try {
		process.env.PI_CODING_AGENT_DIR = agentDir;
		await fs.writeFile(file, "{}");
		release = await lockfile.lock(file, { realpath: false });
		const update = patchPiSettings({ retry: { maxRetries: 7 } });
		await new Promise((resolve) => setTimeout(resolve, 80));
		expect(await fs.readFile(file, "utf8")).toBe("{}");
		await release();
		release = undefined;
		await update;
		expect(JSON.parse(await fs.readFile(file, "utf8")).retry.maxRetries).toBe(7);
	} finally {
		if (release) await release();
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		await fs.rm(agentDir, { recursive: true, force: true });
	}
});

it("waits for a separate process holding the Pi settings lock", async () => {
	const previous = process.env.PI_CODING_AGENT_DIR;
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-settings-process-lock-"));
	const file = path.join(agentDir, "settings.json");
	const script = `import lockfile from "proper-lockfile";
const release = await lockfile.lock(process.argv[1], { realpath: false });
process.stdout.write("locked\\n");
process.stdin.once("data", async () => { await release(); process.exit(0); });`;
	let child: ReturnType<typeof spawn> | undefined;
	try {
		process.env.PI_CODING_AGENT_DIR = agentDir;
		await fs.writeFile(file, "{}");
		child = spawn(process.execPath, ["--input-type=module", "-e", script, file], {
			cwd: process.cwd(),
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});
		const ready = once(child.stdout!, "data");
		const [message] = await Promise.race([
			ready,
			new Promise<never>((_, reject) => setTimeout(() => reject(new Error("lock holder did not start")), 5000)),
		]);
		expect(String(message)).toContain("locked");
		const update = patchPiSettings({ retry: { maxRetries: 9 } });
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(await fs.readFile(file, "utf8")).toBe("{}");
		const exited = once(child, "exit");
		child.stdin!.write("release\n");
		await exited;
		await update;
		expect(JSON.parse(await fs.readFile(file, "utf8")).retry.maxRetries).toBe(9);
	} finally {
		child?.kill();
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		await fs.rm(agentDir, { recursive: true, force: true });
	}
}, 15_000);

describe("设置面板新接管的 pi 设置", () => {
	/** 在临时 agent 目录里跑：绝不碰用户真实的 ~/.pi/agent/settings.json */
	async function withAgentDir<T>(initial: Record<string, unknown>, run: (file: string, agentDir: string) => Promise<T>): Promise<T> {
		const previous = process.env.PI_CODING_AGENT_DIR;
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-settings-extra-"));
		const file = path.join(agentDir, "settings.json");
		try {
			process.env.PI_CODING_AGENT_DIR = agentDir;
			await fs.writeFile(file, JSON.stringify(initial));
			return await run(file, agentDir);
		} finally {
			if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previous;
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	}
	const read = async (file: string) => JSON.parse(await fs.readFile(file, "utf8")) as Record<string, any>;

	it("reads pi's defaults when nothing is set, and tolerates junk in the file", async () => {
		await withAgentDir({}, async () => {
			expect(await getPiSettings()).toMatchObject({
				cacheWarming: "idle", steeringMode: "one-at-a-time", followUpMode: "one-at-a-time", httpProxy: "", shellPath: "",
				compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000, modelOverrides: {} },
			});
		});
		await withAgentDir({ cacheWarming: "sometimes", steeringMode: 3, compaction: { modelOverrides: { "a/b": { reserveTokens: 4000 }, "c/d": "oops", "e/f": { reserveTokens: -1 } } } }, async () => {
			const settings = await getPiSettings();
			expect(settings.cacheWarming).toBe("idle");
			expect(settings.steeringMode).toBe("one-at-a-time");
			// 写坏的条目跳过，不让一条坏数据挡住整个面板
			expect(settings.compaction.modelOverrides).toEqual({ "a/b": { reserveTokens: 4000 } });
		});
	});

	it("writes cache warming and queue delivery modes without touching other fields", async () => {
		await withAgentDir({ theme: "dark", retry: { maxRetries: 7 } }, async (file) => {
			await patchPiSettings({ cacheWarming: "off", steeringMode: "all", followUpMode: "all" });
			expect(await read(file)).toEqual({ theme: "dark", retry: { maxRetries: 7 }, cacheWarming: "off", steeringMode: "all", followUpMode: "all" });
			expect(await getPiSettings()).toMatchObject({ cacheWarming: "off", steeringMode: "all", followUpMode: "all" });
		});
	});

	it("rejects values pi would not understand", () => {
		expect(() => validatePiSettingsPatch({ cacheWarming: "always" })).toThrow(/cacheWarming/);
		expect(() => validatePiSettingsPatch({ steeringMode: "some" })).toThrow(/steeringMode/);
		expect(() => validatePiSettingsPatch({ followUpMode: true })).toThrow(/followUpMode/);
		expect(() => validatePiSettingsPatch({ httpProxy: "not a url" })).toThrow(/httpProxy/);
		expect(() => validatePiSettingsPatch({ httpProxy: "ftp://proxy.local:21" })).toThrow(/httpProxy/);
		expect(() => validatePiSettingsPatch({ shellPath: 42 })).toThrow(/shellPath/);
		// 没有 provider/ 前缀的键 pi 永远匹配不上
		expect(() => validatePiSettingsPatch({ compaction: { modelOverrides: { "gpt-6": { reserveTokens: 1 } } } })).toThrow(/provider\/modelId/);
		expect(() => validatePiSettingsPatch({ compaction: { modelOverrides: { "openai/gpt-6": { reserveTokens: -5 } } } })).toThrow(/non-negative/);
		expect(() => validatePiSettingsPatch({ compaction: { modelOverrides: { "openai/gpt-6": { enabled: false } } } })).toThrow(/unknown compaction override field/);
		expect(() => validatePiSettingsPatch({ compaction: { modelOverrides: [] } })).toThrow(/modelOverrides/);
	});

	it("accepts http, https and socks proxies, and clears the key when emptied", async () => {
		for (const proxy of ["http://127.0.0.1:7890", "https://user:pass@proxy.example.com:8443", "socks5://127.0.0.1:1080"]) {
			expect(validatePiSettingsPatch({ httpProxy: `  ${proxy}  ` })).toEqual({ httpProxy: proxy });
		}
		await withAgentDir({ theme: "dark" }, async (file) => {
			await patchPiSettings({ httpProxy: "http://127.0.0.1:7890" });
			expect((await read(file)).httpProxy).toBe("http://127.0.0.1:7890");
			await patchPiSettings({ httpProxy: "" });
			// 清空 = 删掉键，回到 pi 的默认行为；别的字段还在
			expect(await read(file)).toEqual({ theme: "dark" });
		});
	});

	it("refuses a shell path that does not exist, since every later bash call would fail", async () => {
		await withAgentDir({}, async (file, agentDir) => {
			await expect(patchPiSettings({ shellPath: path.join(agentDir, "no-such-shell") })).rejects.toThrow(/shell not found/);
			expect(await read(file)).toEqual({});
			const shell = path.join(agentDir, "my-shell");
			await fs.writeFile(shell, "");
			await patchPiSettings({ shellPath: shell });
			expect((await read(file)).shellPath).toBe(shell);
			await patchPiSettings({ shellPath: "" });
			expect(await read(file)).toEqual({});
		});
	});

	it("merges per-model compaction thresholds one model at a time", async () => {
		await withAgentDir({ compaction: { reserveTokens: 16384, modelOverrides: { "ollama/qwen": { reserveTokens: 2000 } } } }, async (file) => {
			await patchPiSettings({ compaction: { modelOverrides: { "llama-cpp/phi": { reserveTokens: 1500, keepRecentTokens: 3000 } } } });
			expect((await read(file)).compaction).toEqual({
				reserveTokens: 16384,
				modelOverrides: { "ollama/qwen": { reserveTokens: 2000 }, "llama-cpp/phi": { reserveTokens: 1500, keepRecentTokens: 3000 } },
			});
			// null 删掉那一个模型的覆盖；两项都没写的覆盖也等于删除
			await patchPiSettings({ compaction: { modelOverrides: { "ollama/qwen": null } } });
			expect((await read(file)).compaction.modelOverrides).toEqual({ "llama-cpp/phi": { reserveTokens: 1500, keepRecentTokens: 3000 } });
			await patchPiSettings({ compaction: { modelOverrides: { "llama-cpp/phi": {} } } });
			// 一条都不剩就不留空对象
			expect(await read(file)).toEqual({ compaction: { reserveTokens: 16384 } });
			expect((await getPiSettings()).compaction.modelOverrides).toEqual({});
		});
	});
});
