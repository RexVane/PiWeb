import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadSessionRevocations, resetWebSecretCache, REVOCATIONS_FILENAME } from "../src/lib/web-secret";
import { issuePairCode, refreshPairCode, resetPairingState, verifyPairCode } from "../src/lib/remote/pairing";
import { recycleFixture } from "./fixtures/recycle";

const worker = `
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { readFileSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
registerHooks({
 resolve(specifier, context, next) {
  if (context.parentURL?.endsWith('.ts') && specifier.startsWith('.') && !/\\.[a-z]+$/.test(specifier)) specifier += '.ts';
  return next(specifier, context);
 },
 load(url, context, next) {
  if (url.endsWith('.ts')) return { format: 'module', source: stripTypeScriptTypes(readFileSync(fileURLToPath(url), 'utf8')), shortCircuit: true };
  return next(url, context);
 }
});
const module = await import(pathToFileURL(process.env.REVIEW_MODULE).href);
module.loadSessionRevocations();
const operation = process.env.REVIEW_OPERATION === 'all'
 ? module.revokeAllSessions(5000)
 : module.revokeSessionCookie(process.env.REVIEW_OPERATION, 9000, 1000);
process.send({ type: 'started' });
await operation;
process.send({ type: 'done' });
process.disconnect();
`;

let root: string;
const children: ChildProcess[] = [];
beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-revocations-"));
	vi.stubEnv("PI_CODING_AGENT_DIR", root);
	resetWebSecretCache();
	resetPairingState();
});
afterEach(async () => {
	for (const child of children.splice(0)) if (child.exitCode === null) child.kill();
	vi.unstubAllEnvs();
	resetWebSecretCache();
	resetPairingState();
	await recycleFixture(root);
});

function start(operation: string) {
	const child = spawn(process.execPath, ["--input-type=module", "-e", worker], {
		stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true,
		env: { ...process.env, PI_CODING_AGENT_DIR: root, REVIEW_OPERATION: operation, REVIEW_MODULE: path.resolve("src/lib/web-secret.ts") },
	});
	children.push(child);
	let errors = "";
	child.stderr?.on("data", (chunk) => { errors += String(chunk); });
	let started!: () => void;
	const ready = new Promise<void>((resolve, reject) => {
		started = resolve;
		child.once("error", reject);
		child.once("exit", (code) => { if (code) reject(new Error(errors)); });
	});
	child.on("message", (message: { type?: string }) => { if (message.type === "started") started(); });
	const done = new Promise<void>((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(errors)));
	});
	void done.catch(() => undefined);
	return { ready, done };
}

describe("cross-process session revocations", () => {
	it("refreshes the local pending QR after another process commits all-device logout", async () => {
		const previous = issuePairCode(1_000);
		const inFlight = issuePairCode(6_000);
		const writer = start("all");
		await writer.done;
		const epoch = loadSessionRevocations().notBefore;
		expect(epoch).toBe(5_000);
		expect(verifyPairCode(inFlight.code, 6_001, epoch)).toMatchObject({ ok: false });
		const current = refreshPairCode(previous.code, 6_002, epoch);
		expect(current.code).not.toBe(previous.code);
		expect(refreshPairCode(undefined, 6_003, epoch)).toEqual(current);
		expect(verifyPairCode(current.code, 6_004, epoch)).toEqual({ ok: true });
	});
	it.each([["device-a", "device-b"], ["device-a", "all"]])("serializes %s and %s with an external writer", async (a, b) => {
		const file = path.join(root, REVOCATIONS_FILENAME);
		await fs.writeFile(file, JSON.stringify({ notBefore: 0, revoked: {} }));
		const release = await lockfile.lock(file, { realpath: false });
		const writers = [start(a), start(b)];
		try {
			await Promise.all(writers.map((writer) => writer.ready));
			// Both processes have begun the operation; neither may write before acquiring the lock.
			expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({ notBefore: 0, revoked: {} });
			// Publish newer state after their initial cache read, while still owning the lock.
			await fs.writeFile(file, JSON.stringify({ notBefore: 4000, revoked: { prior: 9000 } }));
		} finally {
			await release();
			await Promise.all(writers.map((writer) => writer.done));
		}
		const current = loadSessionRevocations();
		if (b === "all") {
			expect(current.notBefore).toBe(5000);
			expect(current.revoked.get("device-a")).toBe(9000);
		}
		else {
			expect(current.notBefore).toBe(4000);
			expect([...current.revoked.keys()].sort()).toEqual(["device-a", "device-b", "prior"]);
		}
	});
});
