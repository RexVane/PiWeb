import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { acquireFileLock } from "../scripts/file-lock.mjs";
import { processIdentity, processIdentityAlive } from "../scripts/process-identity.mjs";
import { lockChildEnvironment } from "../scripts/lock-child-env.mjs";
import { runtimeRequire } from "../scripts/runtime-require.mjs";
import { recycleFixture } from "./fixtures/recycle";

const roots: string[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
	for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) await new Promise<void>((resolve) => { child.once("exit", () => resolve()); child.kill(); });
	for (const root of roots.splice(0)) await recycleFixture(root);
});
function fixture() { const root = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-file-lock-")); roots.push(root); return path.join(root, "lock"); }
it("resolves native dependencies from the installed runtime root even when the bundle URL names another checkout", () => {
	const file = fixture(); const root = path.dirname(file);
	fs.mkdirSync(path.join(root, "node_modules", "fixture-native"), { recursive: true });
	fs.writeFileSync(path.join(root, "node_modules", "fixture-native", "index.js"), "module.exports='installed-runtime';");
	const load = runtimeRequire("file:///a-missing-build-machine/scripts/file-lock.mjs", { env: { PI_WEB_ROOT: root }, cwd: process.cwd() });
	expect(load("fixture-native")).toBe("installed-runtime");
	expect(() => load("koffi")).toThrow(/Cannot find module/);
	expect(runtimeRequire("file:///a-missing-build-machine/scripts/file-lock.mjs", { env: {}, cwd: root })("fixture-native")).toBe("installed-runtime");
});
async function childScript(script: string, env: NodeJS.ProcessEnv = process.env) {
	const child = spawn(process.execPath, ["--input-type=module", "-e", script], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env }); children.push(child);
	let output = "", errors = "";
	child.stderr!.on("data", (value) => { errors += value; });
	await new Promise<void>((resolve, reject) => {
		child.stdout!.on("data", (value) => { output += value; if (output.includes("ready")) resolve(); });
		child.once("error", reject); child.once("exit", (code) => reject(new Error(`fixture exited ${code}: ${errors}`)));
	});
	return child;
}
it("ties liveness to process birth and never steals a live owner merely because it is old", () => {
	const current = processIdentity(process.pid);
	expect(current.alive).toBe(true); expect(current.birth).toBeTruthy();
	expect(processIdentityAlive(process.pid, current.birth)).toBe(true);
	expect(processIdentityAlive(process.pid, "a different process creation identity")).toBe(false);
	expect(processIdentityAlive(process.pid)).toBe(true);
	expect(processIdentity(-1)).toEqual({ alive: undefined, birth: null });
	expect(processIdentityAlive(2147483647)).toBe(false);
	const file = fixture();
	fs.writeFileSync(file, JSON.stringify({ pid: process.pid, birth: current.birth, startedAt: "2000-01-01" }));
	expect(() => acquireFileLock(file)).toThrow(/already running/);
});
it("reclaims a reused PID and ignores an abandoned legacy recovery directory", () => {
	const file = fixture();
	fs.mkdirSync(`${file}.recovery`);
	fs.writeFileSync(file, JSON.stringify({ pid: process.pid, birth: "an earlier process", children: [] }));
	const release = acquireFileLock(file); release();
	expect(fs.existsSync(file)).toBe(false);
	expect(fs.statSync(`${file}.recovery`).isDirectory()).toBe(true);
});
it("preserves malformed legacy metadata instead of claiming an unknown live owner", () => {
	const file = fixture(); const broken = '{"pid":'; fs.writeFileSync(file, broken);
	expect(() => acquireFileLock(file)).toThrow(/verify its owner and archive/);
	expect(fs.readFileSync(file, "utf8")).toBe(broken);
});
it("keeps metadata complete during concurrent child tracking and retains live children after parent release", async () => {
	const file = fixture(); const release = acquireFileLock(file);
	const module = pathToFileURL(path.resolve("scripts/file-lock.mjs")).href;
	const processes = await Promise.all(Array.from({ length: 6 }, () => childScript(`import {trackLockChild} from ${JSON.stringify(module)};trackLockChild(${JSON.stringify(file)},${JSON.stringify(release.token)},process.pid);console.log('ready');setInterval(()=>{},1000);`)));
	for (let index = 0; index < 15; index += 1) { release.updateMetadata({ progress: index }); expect(JSON.parse(fs.readFileSync(file, "utf8")).children).toHaveLength(6); }
	const owner = JSON.parse(fs.readFileSync(file, "utf8"));
	expect(new Set(owner.children)).toEqual(new Set(processes.map((child) => child.pid)));
	for (const pid of owner.children) expect(owner.childBirths[pid]).toBeTruthy();
	release();
	expect(JSON.parse(fs.readFileSync(file, "utf8")).released).toBe(true);
	expect(() => acquireFileLock(file)).toThrow(/already running/);
	for (const child of processes) await new Promise<void>((resolve) => { child.once("exit", () => resolve()); child.kill(); });
	const replacement = acquireFileLock(file); release();
	expect(JSON.parse(fs.readFileSync(file, "utf8")).token).toBe(replacement.token);
	replacement();
});
it("recovers a transaction mutex held by a crashed process without stale-file timeouts", async () => {
	const file = fixture();
	const module = pathToFileURL(path.resolve("scripts/file-lock.mjs")).href;
	// Interrupt after the complete temp metadata is synced but before publication.
	const child = await childScript(`import fs from 'node:fs';import {acquireFileLock} from ${JSON.stringify(module)};fs.renameSync=()=>{console.log('ready');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,60000)};acquireFileLock(${JSON.stringify(file)});`);
	await new Promise<void>((resolve) => { child.once("exit", () => resolve()); child.kill(); });
	const release = acquireFileLock(file); expect(JSON.parse(fs.readFileSync(file, "utf8")).pid).toBe(process.pid); release();
});
it("prevents an unregistered child from starting its entrypoint after the parent lost ownership", () => {
	const file = fixture(); const first = acquireFileLock(file); const oldToken = first.token; first();
	const replacement = acquireFileLock(file); const marker = path.join(path.dirname(file), "must-not-run");
	const result = spawnSync(process.execPath, ["--input-type=module", "-e", `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'ran');`], {
		windowsHide: true, encoding: "utf8", env: lockChildEnvironment(process.env, file, oldToken),
	});
	expect(result.status).not.toBe(0);
	expect(result.stderr).toContain("lock ownership changed");
	expect(fs.existsSync(marker)).toBe(false);
	expect(JSON.parse(fs.readFileSync(file, "utf8")).token).toBe(replacement.token);
	replacement();
});
it("tracks only the service root, not a descendant that inherits the lock environment", async () => {
	const file = fixture(); const release = acquireFileLock(file);
	expect(lockChildEnvironment({ ...process.env, PIWEB_PROCESS_LOCK_TRACKED: "1" }, file, release.token).PIWEB_PROCESS_LOCK_TRACKED).toBeUndefined();
	const script = `
		import { spawn } from "node:child_process";
		const child = spawn(process.execPath, ["--input-type=module", "-e", "process.exit(0)"], { stdio: "ignore" });
		await new Promise((resolve) => child.once("exit", resolve));
		console.log("ready");
		setInterval(() => {}, 1000);
	`;
	const service = await childScript(script, lockChildEnvironment(process.env, file, release.token));
	const owner = JSON.parse(fs.readFileSync(file, "utf8"));
	expect(owner.children).toEqual([service.pid]);
	release();
});
