import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAutomationTask, listAutomations, reconcileInterruptedRuns } from "../src/lib/automations/store";

// The real store and cross-process lock run in independent Node processes. Only
// unused application runtime imports are stubbed; no agent session is started.
const worker = `
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { readFileSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
registerHooks({
 resolve(specifier, context, next) {
  if (context.parentURL?.endsWith('/automations/store.ts') && specifier === '../pi')
   return { url: 'data:text/javascript,export const getAgentDir=()=>process.env.REVIEW_ROOT;', shortCircuit: true };
  if (context.parentURL?.endsWith('/automations/store.ts') && specifier === '../path-security')
   return { url: 'data:text/javascript,export const resolveWorkspacePath=async p=>p;', shortCircuit: true };
  if (context.parentURL?.endsWith('.ts') && specifier.startsWith('.') && !/\\.[a-z]+$/.test(specifier)) specifier += '.ts';
  return next(specifier, context);
 },
 load(url, context, next) {
  if (url.endsWith('.ts')) return { format: 'module', source: stripTypeScriptTypes(readFileSync(fileURLToPath(url), 'utf8')), shortCircuit: true };
  return next(url, context);
 }
});
const store = await import(pathToFileURL(process.env.REVIEW_MODULE).href);
process.on('message', message => { if(message === 'finish') process.disconnect(); });
process.send({ type: 'ready' });
try {
 const result = process.env.REVIEW_OPERATION === 'claim'
  ? await store.claimDueTasks(60001, new Set(), process.env.REVIEW_STORE)
  : await store.recordRunStarted(await store.getAutomationTask(process.env.REVIEW_TASK, process.env.REVIEW_STORE), 'manual', Date.now(), process.env.REVIEW_STORE);
 process.send({ type: 'done', result });
} catch (error) { process.send({ type: 'done', error: { name: error.name, message: error.message } }); }
`;

let root: string;
let file: string;
let taskId: string;
const children: ChildProcess[] = [];
beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-automation-concurrency-"));
	file = path.join(root, "automations.json");
	taskId = (await createAutomationTask({ name: "Shared task", prompt: "Offline test", cwd: root, schedule: { kind: "interval", every: 1, unit: "minutes" } }, file, 0)).id;
});
afterEach(async () => {
	await Promise.all(children.splice(0).map((child) => new Promise<void>((resolve) => {
		if (child.exitCode !== null) return resolve();
		child.once("exit", () => resolve());
		child.kill();
	})));
	await fs.rm(root, { recursive: true, force: true });
});

function start(operation: "claim" | "start") {
	const child = spawn(process.execPath, ["--input-type=module", "-e", worker], {
		stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true,
		env: { ...process.env, REVIEW_ROOT: root, REVIEW_MODULE: path.resolve("src/lib/automations/store.ts"), REVIEW_STORE: file, REVIEW_TASK: taskId, REVIEW_OPERATION: operation },
	});
	children.push(child);
	let stderr = "";
	child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
	const event = (type: string) => new Promise<any>((resolve, reject) => {
		child.on("message", (message: { type?: string }) => { if (message.type === type) resolve(message); });
		child.once("error", reject);
		child.once("exit", (code) => { if (code) reject(new Error(stderr)); });
	});
	return { child, ready: event("ready"), done: event("done") };
}

describe("automation multi-process coordination", () => {
	it("claims a due task once and respects the external write lock", async () => {
		const release = await lockfile.lock(file, { realpath: false });
		const workers = [start("claim"), start("claim")];
		try {
			await Promise.all(workers.map((worker) => worker.ready));
			await new Promise((resolve) => setTimeout(resolve, 100));
			expect((await listAutomations(file)).tasks[0].nextRunAt).toBe(60_000);
		} finally { await release(); }
		const results = await Promise.all(workers.map((worker) => worker.done));
		expect(results.map((result) => result.result.length).sort()).toEqual([0, 1]);
		expect((await listAutomations(file)).tasks[0].nextRunAt).toBe(120_000);
	});

	it("allows only one live manual owner and does not interrupt it on another instance's startup", async () => {
		const workers = [start("start"), start("start")];
		const results = await Promise.all(workers.map((worker) => worker.done));
		expect(results.filter((result) => result.result)).toHaveLength(1);
		expect(results.find((result) => result.error)?.error.name, JSON.stringify(results)).toBe("AutomationConflictError");
		expect(await reconcileInterruptedRuns(new Set(), file)).toBe(0);
		expect((await listAutomations(file)).runs).toHaveLength(1);
		await Promise.all(workers.map(({ child }) => new Promise<void>((resolve) => {
			child.once("exit", () => resolve());
			child.send("finish");
		})));
		expect(await reconcileInterruptedRuns(new Set(), file)).toBeGreaterThan(0);
		expect((await listAutomations(file)).runs[0].status).toBe("error");
	});
});
