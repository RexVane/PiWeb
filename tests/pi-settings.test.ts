import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import lockfile from "proper-lockfile";
import { describe, expect, it } from "vitest";
import { getPiSettings, patchPiSettings, validatePiSettingsPatch } from "../src/lib/pi-settings";
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

	it("validates thinking levels, per-model keys, budgets and the default model", () => {
		expect(validatePiSettingsPatch({
			thinking: { defaultLevel: "high", modelLevels: { "openrouter/anthropic/claude": "max", "p/m": null }, budgets: { low: 2048, high: null } },
			defaultModel: { provider: " p ", modelId: " m " },
		})).toEqual({
			thinking: { defaultLevel: "high", modelLevels: { "openrouter/anthropic/claude": "max", "p/m": null }, budgets: { low: 2048, high: null } },
			defaultModel: { provider: "p", modelId: "m" },
		});
		expect(validatePiSettingsPatch({ thinking: { defaultLevel: null }, defaultModel: null })).toEqual({ thinking: { defaultLevel: null }, defaultModel: null });
		for (const bad of [
			{ thinking: { defaultLevel: "turbo" } },
			{ thinking: { modelLevels: { "no-slash": "high" } } },
			{ thinking: { modelLevels: { "/m": "high" } } },
			{ thinking: { modelLevels: { "p/m": "turbo" } } },
			{ thinking: { budgets: { xhigh: 100 } } },
			{ thinking: { budgets: { low: 0 } } },
			{ thinking: { budgets: { low: 1.5 } } },
			{ thinking: { extra: 1 } },
			{ defaultModel: { provider: "p" } },
			{ defaultModel: { provider: "a/b", modelId: "m" } },
			{ defaultModel: { provider: "p", modelId: "m", extra: 1 } },
		]) expect(() => validatePiSettingsPatch(bad), JSON.stringify(bad)).toThrow();
	});
});

it("writes thinking settings with pi's own keys and removes emptied sections", async () => {
	const previous = process.env.PI_CODING_AGENT_DIR;
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-settings-thinking-"));
	const file = path.join(agentDir, "settings.json");
	try {
		process.env.PI_CODING_AGENT_DIR = agentDir;
		await fs.writeFile(file, JSON.stringify({ theme: "dark", modelThinkingLevels: { "a/x": "low" }, defaultThinkingLevel: "bogus" }));
		expect((await getPiSettings()).thinking).toEqual({ defaultLevel: null, modelLevels: { "a/x": "low" }, budgets: {} });

		await patchPiSettings({
			thinking: { defaultLevel: "high", modelLevels: { "p/m": "max" }, budgets: { medium: 9000 } },
			defaultModel: { provider: "p", modelId: "m" },
		});
		expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({
			theme: "dark",
			defaultThinkingLevel: "high",
			modelThinkingLevels: { "a/x": "low", "p/m": "max" },
			thinkingBudgets: { medium: 9000 },
			defaultProvider: "p",
			defaultModel: "m",
		});
		const read = await getPiSettings();
		expect(read.thinking).toEqual({ defaultLevel: "high", modelLevels: { "a/x": "low", "p/m": "max" }, budgets: { medium: 9000 } });
		expect(read.defaultModel).toEqual({ provider: "p", modelId: "m" });

		await patchPiSettings({ thinking: { defaultLevel: null, modelLevels: { "a/x": null, "p/m": null }, budgets: { medium: null } }, defaultModel: null });
		expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({ theme: "dark" });
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
