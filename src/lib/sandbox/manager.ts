/** Per-session AppContainer lifecycle and capability reporting. */
import path from "node:path";
import { getAgentDir } from "../pi";
import { createAclSandbox, probeAclSandboxCapability, type AclSandbox, type SandboxShell, type SandboxCapability } from "./windows-acl";

export type SandboxMode = "readonly" | "workspace";
export interface SandboxRequest {
	mode: SandboxMode;
	shell?: SandboxShell;
	extraRoots?: string[];
}
interface Holder {
	sandbox: AclSandbox;
	tempDir: string;
}
let capability: SandboxCapability | null = null;
let probing: Promise<boolean> | null = null;
const holders = new Map<string, Promise<Holder | null>>();
const generations = new Map<string, number>();
/** A holder leaves the pool before its async SID/process/temp cleanup finishes. */
const releases = new Map<string, Promise<void>>();

export function probeSandboxSupport(): Promise<boolean> {
	if (capability) return Promise.resolve(capability.available);
	probing ??= probeAclSandboxCapability().then((value) => {
		capability = value;
		probing = null;
		return value.available;
	});
	return probing;
}
export function sandboxSupported(): boolean { return capability?.available === true; }
export function sandboxCapability(): SandboxCapability {
	return capability ?? { available: false, backend: null, unsupportedReason: "Isolation capability has not been checked yet." };
}
function normalized(value: string): string {
	const resolved = path.resolve(value);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
function keyOf(sessionPath: string, cwd: string, request: SandboxRequest): string {
	return sessionPath + "\0" + JSON.stringify({
		mode: request.mode,
		cwd: normalized(cwd),
		extraRoots: request.mode === "workspace" ? [...new Set((request.extraRoots ?? []).map(normalized))].sort() : [],
		shell: request.shell ?? { path: "cmd.exe", transport: "argv" },
	});
}
export function sandboxFor(sessionPath: string, cwd: string, request: SandboxRequest): Promise<Holder | null> {
	const key = keyOf(sessionPath, cwd, request);
	const existing = holders.get(key);
	if (existing) return existing;
	const generation = generations.get(sessionPath) ?? 0;
	const created = (async () => {
		if (!(await probeSandboxSupport())) return null;
		const sandbox = await createAclSandbox({
			writableDirs: request.mode === "workspace" ? [cwd, ...(request.extraRoots ?? [])] : [],
			readableDirs: request.mode === "readonly" ? [cwd] : [],
			// createAclSandbox always owns a unique child, even when modes coexist.
			tempDir: request.mode === "workspace" ? path.join(getAgentDir(), "web-sandbox") : null,
			...(request.shell ? { shell: request.shell } : {}),
		});
		if (!sandbox) return null;
		if ((generations.get(sessionPath) ?? 0) !== generation) {
			await sandbox.dispose();
			return null;
		}
		return { sandbox, tempDir: sandbox.tempDir };
	})().catch((error) => {
		console.warn("[piweb] Could not create session isolation:", error instanceof Error ? error.message : String(error));
		return null;
	});
	holders.set(key, created);
	void created.then((value) => { if (!value && holders.get(key) === created) holders.delete(key); });
	return created;
}
export function hasSandbox(sessionPath: string): boolean {
	for (const key of holders.keys()) if (key.startsWith(sessionPath + "\0")) return true;
	return false;
}
export function releaseSandbox(sessionPath: string): Promise<void> {
	generations.set(sessionPath, (generations.get(sessionPath) ?? 0) + 1);
	const prefix = sessionPath + "\0";
	const pending: Promise<Holder | null>[] = [];
	for (const [key, holder] of holders) {
		if (key.startsWith(prefix)) { holders.delete(key); pending.push(holder); }
	}
	const previous = releases.get(sessionPath);
	if (!pending.length) return previous ?? Promise.resolve();
	// Instances own their own scratch; never remove a stable shared parent.
	const releasing = (async () => {
		const results = await Promise.allSettled([
			...(previous ? [previous] : []), ...pending.map(async (holder) => (await holder)?.sandbox.dispose()),
		]);
		for (const result of results) if (result.status === "rejected") console.warn("[piweb] Could not dispose session isolation:", result.reason);
	})();
	releases.set(sessionPath, releasing);
	void releasing.finally(() => { if (releases.get(sessionPath) === releasing) releases.delete(sessionPath); });
	return releasing;
}
export async function resetSandboxStateForTests(): Promise<void> {
	for (const session of new Set([...holders.keys()].map((key) => key.split("\0")[0]).concat([...releases.keys()]))) await releaseSandbox(session);
	capability = null;
	probing = null;
	generations.clear();
}
