import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { replaceFileAtomically } from "./atomic-file";
import { withExternalSettingsLock, withSettingsWriteLock } from "./settings-write-lock";
import { readFileBounded } from "./read-file-bounded";

interface Activity {
	id: string; session: string; startedAt: number; finishedAt?: number;
	participants: Set<string>; ready: Promise<void>; timer?: ReturnType<typeof setInterval>;
}
interface WorkspaceActivity { root?: string; active: Map<string, Activity>; runs: Map<string, Activity> }
const globalActivity = globalThis as typeof globalThis & { __piwebGrowthActivity?: Map<string, WorkspaceActivity> };
const workspaces = globalActivity.__piwebGrowthActivity ??= new Map();
const LEASE_MS = 5 * 60_000;
const key = (cwd: string) => process.platform === "win32" ? path.resolve(cwd).toLowerCase() : path.resolve(cwd);
const name = (session: string) => path.basename(session).replace(/[\r\n\x00]/g, "");
function state(cwd: string): WorkspaceActivity {
	const id = key(cwd); let workspace = workspaces.get(id);
	if (!workspace) { workspace = { active: new Map(), runs: new Map() }; workspaces.set(id, workspace); }
	return workspace;
}

async function writeMarker(workspace: WorkspaceActivity, run: Activity): Promise<void> {
	if (!workspace.root) return;
	// An active turn can outlive the repository. Only the marker directory can be created here.
	await fs.mkdir(workspace.root, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
		if (error.code !== "EEXIST") throw error;
	});
	const file = path.join(workspace.root, `${run.id}.json`); const temporary = `${file}.${randomUUID()}.tmp`;
	await withSettingsWriteLock(file, () => withExternalSettingsLock(file, async () => {
		try {
			await fs.writeFile(temporary, JSON.stringify({ id: run.id, session: run.session, pid: process.pid, startedAt: run.startedAt,
				finishedAt: run.finishedAt, participants: [...run.participants], heartbeatAt: Date.now() }), { flag: "wx", mode: 0o600 });
			await replaceFileAtomically(temporary, file);
		} finally { await fs.unlink(temporary).catch(() => undefined); }
	}, { createParent: false }));
}

function startMarker(workspace: WorkspaceActivity, run: Activity): void {
	if (!workspace.root || run.timer) return;
	run.ready = writeMarker(workspace, run).catch(() => { run.participants.add("记录状态不可用"); });
	run.timer = setInterval(() => {
		run.ready = run.ready.then(() => writeMarker(workspace, run)).catch(() => { run.participants.add("记录状态不可用"); });
	}, 30_000);
	run.timer.unref?.();
}

/** Disk coordination is enabled only after explicit recording consent. */
export function enableGrowthActivity(cwd: string, gitDir: string): void {
	const workspace = state(cwd); workspace.root = path.join(gitDir, "piweb", "activity");
	for (const run of workspace.runs.values()) startMarker(workspace, run);
}

export function beginGrowthRun(cwd: string, session: string): void {
	const workspace = state(cwd); const sessionKey = key(session);
	if (workspace.active.has(sessionKey)) return;
	const run: Activity = { id: randomUUID(), session: name(session), startedAt: Date.now(), participants: new Set(), ready: Promise.resolve() };
	for (const existing of workspace.active.values()) {
		existing.participants.add(run.session); run.participants.add(existing.session);
	}
	workspace.active.set(sessionKey, run); workspace.runs.set(run.id, run); startMarker(workspace, run);
}

export interface GrowthAttribution { runId?: string; attribution?: "shared"; concurrentSessions?: string[] }
export function finishGrowthRun(cwd: string, session: string): GrowthAttribution {
	const workspace = state(cwd); const sessionKey = key(session); const run = workspace.active.get(sessionKey);
	if (!run) return {};
	run.finishedAt = Date.now(); workspace.active.delete(sessionKey);
	return { runId: run.id, ...(run.participants.size ? { attribution: "shared", concurrentSessions: [run.session, ...run.participants] } : {}) };
}

export async function resolveGrowthAttribution(cwd: string, metadata: GrowthAttribution, session?: string): Promise<GrowthAttribution> {
	const workspace = state(cwd); const run = metadata.runId ? workspace.runs.get(metadata.runId) : {
		id: randomUUID(), session: name(session ?? ""), startedAt: Date.now(), finishedAt: Date.now(),
		participants: new Set([...workspace.active.values()].map((activity) => activity.session)), ready: Promise.resolve(),
	};
	if (!run) return metadata;
	await run.ready;
	if (workspace.root) {
		for (const file of await fs.readdir(workspace.root).catch(() => [])) {
			if (!/^[a-f0-9-]+\.json$/.test(file)) continue;
			try {
				const location = path.join(workspace.root, file);
				const peer = JSON.parse((await readFileBounded(location, 16 * 1024)).toString("utf8"));
				if (peer.id === run.id || typeof peer.session !== "string" || typeof peer.startedAt !== "number") continue;
				if (typeof peer.heartbeatAt !== "number" || Date.now() - peer.heartbeatAt > LEASE_MS) continue;
				if (!peer.finishedAt) { try { process.kill(peer.pid, 0); } catch { continue; } }
				if (peer.startedAt <= (run.finishedAt ?? Date.now()) && (peer.finishedAt ?? Date.now()) >= run.startedAt) run.participants.add(name(peer.session));
			} catch { run.participants.add("记录状态不可用"); }
		}
	}
	if (metadata.runId) await writeMarker(workspace, run).catch(() => { run.participants.add("记录状态不可用"); });
	return { runId: run.id, ...(run.participants.size ? { attribution: "shared", concurrentSessions: [...new Set([run.session, ...run.participants])] } : {}) };
}

/** Keep a short completed marker for peers; only ephemeral activity files expire. */
export async function completeGrowthRun(cwd: string, runId?: string): Promise<void> {
	if (!runId) return;
	const workspace = state(cwd); const run = workspace.runs.get(runId);
	if (!run) return;
	if (run.timer) clearInterval(run.timer);
	run.finishedAt ??= Date.now(); await run.ready; await writeMarker(workspace, run).catch(() => undefined);
	workspace.runs.delete(runId);
	if (!workspace.root) return;
	for (const file of await fs.readdir(workspace.root).catch(() => [])) {
		if (!/^[a-f0-9-]+\.json$/.test(file)) continue;
		const location = path.join(workspace.root, file);
		if (!await fs.stat(location).then((stat) => Date.now() - stat.mtimeMs > LEASE_MS, () => false)) continue;
		// Heartbeats atomically replace the marker. Check expiry and remove under
		// the same per-marker lock so an old stat cannot delete a fresh heartbeat.
		await withSettingsWriteLock(location, () => withExternalSettingsLock(location, async () => {
			if (await fs.stat(location).then((stat) => Date.now() - stat.mtimeMs > LEASE_MS, () => false)) await fs.unlink(location).catch(() => undefined);
		}, { createParent: false })).catch(() => undefined);
	}
}
