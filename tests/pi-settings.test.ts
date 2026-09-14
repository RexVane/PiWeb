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
