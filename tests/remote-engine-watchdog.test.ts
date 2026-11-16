import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, expect, it } from "vitest";
import { terminateProcessTree } from "../scripts/process-runner.mjs";
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function alive(pid: number) { try { process.kill(pid, 0); return true; } catch { return false; } }
it("terminates its owned engine after the parent IPC disconnects", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-watchdog-"));
	cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
	const file = path.join(root, "engine.cjs"); await fs.writeFile(file, "console.log('PID:'+process.pid);setInterval(()=>{},1000);");
	const child = spawn(process.execPath, [path.resolve("scripts/remote-engine.mjs"), file], { stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true, detached: process.platform !== "win32", env: { ...process.env, NODE_OPTIONS: "", NODE_ENV: "production" } });
	cleanups.push(() => child.exitCode === null ? terminateProcessTree(child) : Promise.resolve());
	const pid = await new Promise<number>((resolve, reject) => { let output = ""; child.stdout!.on("data", (chunk) => { output += chunk; const match = /PID:(\d+)/.exec(output); if (match) resolve(Number(match[1])); }); child.once("error", reject); child.once("exit", (code) => reject(new Error(`watchdog exited ${code}`))); });
	cleanups.push(() => {
		if (alive(pid)) {
			try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
		}
		return Promise.resolve();
	});
	expect(alive(pid)).toBe(true);
	const exited = new Promise<void>((resolve) => child.once("exit", () => resolve())); child.disconnect(); await exited;
	for (let i = 0; i < 100 && alive(pid); i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
	expect(alive(pid)).toBe(false);
});
