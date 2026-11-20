import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { getAgentDir } from "../pi";
import { replaceFileAtomically } from "../atomic-file";
import { withExternalSettingsLock, withSettingsWriteLock } from "../settings-write-lock";
import { registerShutdownHook } from "../graceful-shutdown";
import { resolveWorkspacePath, isPathInside } from "../path-security";
import { discoverResourcePackages } from "./discovery";
import { resourceHostCode } from "./host-code";
import type { JsonValue, ResourceActionContext, ResourceHostApi, ResourcePackage, ResourceRunRequest, ResourceRunResult } from "./protocol";

const STATE_KEY = Symbol.for("piweb.resources.host.v1");
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/;
type Action = (args: JsonValue, context: ResourceActionContext) => Promise<JsonValue> | JsonValue;
interface Entry {
	key: string;
	agentDir: string;
	resource: ResourcePackage;
	fingerprint: string;
	controller: AbortController;
	actions: Map<string, Action>;
	stops: Map<string, () => unknown>;
	services: Set<string>;
	active: number;
	idle: Array<() => void>;
	stopping: boolean;
	loading?: Promise<void>;
	cleanup?: () => unknown;
	error?: string;
	stopPromise?: Promise<void>;
}
interface HostState { entries: Map<string, Entry>; queue: Promise<unknown>; workspaces: Set<string> }
function state(): HostState {
	const store = globalThis as Record<PropertyKey, unknown>;
	return (store[STATE_KEY] ??= { entries: new Map(), queue: Promise.resolve(), workspaces: new Set() }) as HostState;
}
function key(resource: ResourcePackage): string {
	return `${getAgentDir()}\n${resource.scope}\n${resource.scope === "project" ? resource.cwd : ""}\n${resource.source}\n${resource.id}`;
}
function serialized<T>(operation: () => Promise<T>): Promise<T> {
	const s = state();
	const result = s.queue.then(operation, operation);
	s.queue = result.then(() => undefined, () => undefined);
	return result;
}
function finishWork(entry: Entry): void {
	entry.active -= 1;
	if (entry.active === 0) for (const resolve of entry.idle.splice(0)) resolve();
}
export function resourceJson(value: unknown, maxBytes = MAX_JSON_BYTES): JsonValue {
	const text = JSON.stringify(value === undefined ? null : value);
	if (!text || Buffer.byteLength(text) > maxBytes) throw new Error("Resource data exceeds the JSON budget");
	return JSON.parse(text) as JsonValue;
}

async function stopEntry(entry: Entry): Promise<void> {
	if (entry.stopPromise) return entry.stopPromise;
	entry.stopping = true;
	entry.actions.clear();
	entry.controller.abort(new Error("Resource is stopping"));
	entry.stopPromise = (async () => {
		await entry.loading?.catch(() => undefined);
		for (const stop of entry.stops.values()) {
			try { await stop(); } catch { entry.error = "Resource service cleanup failed"; }
		}
		entry.stops.clear();
		if (entry.active > 0) await new Promise<void>((resolve) => entry.idle.push(resolve));
		try { await entry.cleanup?.(); } catch { entry.error = "Resource cleanup failed"; }
		const s = state();
		if (s.entries.get(entry.key) === entry) s.entries.delete(entry.key);
	})();
	return entry.stopPromise;
}

async function storageFile(entry: Entry, dataDir: string, name: string): Promise<string> {
	if (!NAME.test(name) || name.includes("..")) throw new Error("Invalid resource storage filename");
	await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
	const root = await fs.realpath(path.join(entry.agentDir, "web-resource-data"));
	const real = await fs.realpath(dataDir);
	if (!isPathInside(root, real)) throw new Error("Resource storage escapes its namespace");
	const file = path.join(real, name);
	const target = await fs.realpath(file).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
	if (target && (!isPathInside(real, target) || target !== file)) throw new Error("Resource storage cannot follow a file symlink");
	if (entry.stopping && entry.active === 0) throw new Error("Resource is stopping");
	return file;
}

function makeApi(entry: Entry): ResourceHostApi {
	const resource = entry.resource;
	const namespace = createHash("sha256").update(`${entry.agentDir}\n${resource.scope}\n${resource.scope === "project" ? resource.cwd : ""}\n${resource.id}`).digest("hex");
	const dataDir = path.join(entry.agentDir, "web-resource-data", namespace);
	return {
		apiVersion: 1, id: resource.id, cwd: resource.cwd, scope: resource.scope,
		agentDir: entry.agentDir, dataDir, signal: entry.controller.signal,
		actions: { register(name, handler) {
			if (!NAME.test(name) || typeof handler !== "function" || entry.stopping || entry.actions.has(name)) throw new Error("Invalid or duplicate resource action");
			entry.actions.set(name, handler);
			return () => { if (entry.actions.get(name) === handler) entry.actions.delete(name); };
		} },
		services: { register(name, start) {
			if (!NAME.test(name) || typeof start !== "function" || entry.stopping || entry.services.has(name)) throw new Error("Invalid or duplicate resource service");
			entry.services.add(name);
			let removed = false;
			const stopService = async () => { removed = true; await entry.stops.get(name)?.(); entry.stops.delete(name); entry.services.delete(name); };
			entry.active += 1;
			void Promise.resolve().then(() => entry.stopping ? undefined : start(entry.controller.signal)).then(async (stop) => {
				if (typeof stop !== "function") return;
				if (removed || entry.stopping) await stop(); else entry.stops.set(name, stop);
			}).catch(() => { entry.error = "Resource service failed"; }).finally(() => finishWork(entry));
			return () => { void stopService().catch(() => { entry.error = "Resource service cleanup failed"; }); };
		} },
		storage: {
			async read(name) {
				const file = await storageFile(entry, dataDir, name);
				try {
					if ((await fs.stat(file)).size > MAX_JSON_BYTES) throw new Error("Resource storage is too large");
					return resourceJson(JSON.parse(await fs.readFile(file, "utf8")));
				} catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
			},
			async write(name, value) {
				const file = await storageFile(entry, dataDir, name);
				const text = `${JSON.stringify(resourceJson(value), null, 2)}\n`;
				if (Buffer.byteLength(text) > MAX_JSON_BYTES) throw new Error("Resource storage is too large");
				await withSettingsWriteLock(file, () => withExternalSettingsLock(file, async () => {
					await storageFile(entry, dataDir, name);
					const temporary = `${file}.${randomUUID()}.tmp`;
					try { await fs.writeFile(temporary, text, { flag: "wx", mode: 0o600 }); await replaceFileAtomically(temporary, file); }
					finally { await fs.unlink(temporary).catch(() => undefined); }
				}));
			},
		},
		paths: { resolveWorkspace: resolveWorkspacePath },
		sessions: { async run(request) {
			if (entry.stopping) throw new Error("Resource is stopping");
			entry.active += 1;
			try { return await runResourceSession(request); } finally { finishWork(entry); }
		} },
	};
}

async function ensureEntry(resource: ResourcePackage): Promise<Entry> {
	if (!resource.enabled || !resource.manifest?.host) throw new Error("Resource host is not enabled");
	return serialized(async () => {
		const code = await resourceHostCode(resource, getAgentDir());
		const file = code.file;
		const fingerprint = code.revision;
		const s = state();
		const previous = s.entries.get(key(resource));
		if (previous && previous.fingerprint === fingerprint && !previous.stopping) { await previous.loading; if (previous.error) throw new Error(previous.error); return previous; }
		if (previous) {
			if (previous.active > 0) { void stopEntry(previous); throw new Error("Resource update is waiting for active work to finish"); }
			await stopEntry(previous);
		}
		const entry: Entry = { key: key(resource), agentDir: getAgentDir(), resource, fingerprint, controller: new AbortController(), actions: new Map(), stops: new Map(), services: new Set(), active: 0, idle: [], stopping: false };
		s.entries.set(key(resource), entry);
		entry.loading = (async () => {
			// Node loads the installed entry, never the application's build graph. Only approved, enabled package entries reach here.
			const url = `${pathToFileURL(file).href}?piweb=${createHash("sha256").update(fingerprint).digest("hex")}`;
			const module = await import(/* webpackIgnore: true */ url) as { activate?: (api: ResourceHostApi) => unknown };
			if (typeof module.activate !== "function") throw new Error("Resource host must export activate(host)");
			const cleanup = await module.activate(makeApi(entry));
			if (typeof cleanup === "function") entry.cleanup = cleanup as () => unknown;
		})();
		try { await entry.loading; } catch { entry.error = "Resource host activation failed"; void stopEntry(entry); throw new Error(entry.error); }
		return entry;
	});
}

export async function invokeResourceAction(resourceId: string, action: string, args: unknown, context: ResourceActionContext): Promise<JsonValue> {
	if (!NAME.test(action)) throw new Error("Invalid resource action");
	const candidates = (await discoverResourcePackages(context.cwd)).filter((resource) => resource.enabled && resource.id === resourceId && (!context.scope || resource.scope === context.scope) && resource.manifest?.host);
	if (candidates.length !== 1) throw new Error("Resource is unavailable or has a conflicting id");
	const entry = await ensureEntry(candidates[0]);
	const handler = entry.actions.get(action);
	if (!handler || entry.stopping) throw new Error("Resource action is unavailable");
	context.signal?.throwIfAborted();
	entry.active += 1;
	try { return resourceJson(await handler(resourceJson(args), context)); } finally { finishWork(entry); }
}

/** Stop missing entries without blocking a settings request on a long-running job. */
export async function reconcileResourceHosts(cwd: string, options: { startGlobal?: boolean } = {}): Promise<void> {
	const global = await discoverResourcePackages(cwd, { globalOnly: true });
	const local = await discoverResourcePackages(cwd);
	const enabled = new Map([...global, ...local.filter((resource) => resource.scope === "project")].filter((resource) => resource.enabled && resource.manifest?.host).map((resource) => [key(resource), resource]));
	for (const [id, entry] of state().entries) {
		if (entry.resource.scope === "project" && entry.resource.cwd !== cwd) continue;
		if (!enabled.has(id)) void stopEntry(entry);
	}
	if (options.startGlobal) for (const resource of [...global, ...(state().workspaces.has(cwd) ? local.filter((item) => item.scope === "project") : [])].filter((item) => item.enabled && item.manifest?.host)) {
		await ensureEntry(resource).catch(() => undefined);
	}
}

export async function startResourceWorkspace(cwd: string): Promise<void> {
	state().workspaces.add(cwd);
	await reconcileResourceHosts(cwd, { startGlobal: true });
}

export function resourceHostStatuses(): Array<{ id: string; scope: string; state: "running" | "stopping" | "error"; services: string[]; active: number }> {
	return [...state().entries.values()].map((entry) => ({ id: entry.resource.id, scope: entry.resource.scope,
		state: entry.stopping ? "stopping" : entry.error ? "error" : "running", services: [...entry.services], active: entry.active }));
}

export function startResourceHost(cwd: string): Promise<void> {
	registerShutdownHook(async () => { await Promise.all([...state().entries.values()].map(stopEntry)); }, { name: "resource-host" });
	return reconcileResourceHosts(cwd, { startGlobal: true });
}

/** Public session service; no automation-specific rules, storage, schedules or tool names. */
export async function runResourceSession(request: ResourceRunRequest): Promise<ResourceRunResult> {
	if (typeof request.prompt !== "string" || !request.prompt.trim() || request.prompt.length > 50_000) throw new Error("Invalid resource prompt");
	const timeoutMs = request.timeoutMs ?? 30 * 60_000;
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 24 * 60 * 60_000) throw new Error("Invalid resource run timeout");
	const timeout = AbortSignal.timeout(timeoutMs);
	const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
	signal.throwIfAborted();
	const cwd = await resolveWorkspacePath(request.cwd);
	const manager = await import("../agent-manager");
	const created = await manager.createNewSession(cwd);
	const managed = manager.getManaged(created.sessionPath);
	managed.headless = true;
	let unavailable = false;
	const errors: string[] = [];
	const unsubscribe = manager.observeManagedEvents(managed, (event) => {
		if (event.type === "interaction_unavailable") unavailable = true;
		if (event.type === "error") errors.push(event.message);
	});
	let stopPromise: Promise<{ ok: boolean; error?: string }> | undefined;
	const stop = () => { stopPromise ??= manager.execute(managed, { cmd: "abort" }).catch(() => ({ ok: false })); };
	const waitForStop = async () => {
		for (;;) {
			if (managed.disposed) return;
			stop();
			const result = await stopPromise;
			if (result?.ok) return;
			// Keep unattended mode and the caller's running slot until the actual run acknowledges stop.
			stopPromise = undefined;
			await new Promise((resolve) => setTimeout(resolve, 5_000));
		}
	};
	signal.addEventListener("abort", stop, { once: true });
	try {
		await request.onSession?.(created.sessionPath);
		if (request.title) await manager.execute(managed, { cmd: "rename", text: request.title.slice(0, 200) });
		if (request.model) {
			const result = await manager.execute(managed, { cmd: "setModel", provider: request.model.provider, modelId: request.model.id, fresh: true });
			if (!result.ok) throw new Error(result.error || "Resource model is unavailable");
		}
		signal.throwIfAborted();
		const submitted = await manager.execute(managed, { cmd: "prompt", text: request.prompt });
		if (!submitted.ok) throw new Error(submitted.error || "Resource prompt was not accepted");
		while (managed.runActive || managed.commandRunning || managed.bashActive || managed.promptSubmitting || managed.resourceReloading || managed.stopping || managed.session && !managed.session.isIdle) {
			if (unavailable) { stop(); throw new Error("Resource execution requires human input; no operation was approved"); }
			signal.throwIfAborted();
			await new Promise((resolve) => setTimeout(resolve, 30));
		}
		if (unavailable) throw new Error("Resource execution requires human input; no operation was approved");
		signal.throwIfAborted();
		const latest = manager.getSessionHistory(managed).messages.findLast((message) => message.role === "assistant");
		const summary = latest?.content.filter((part) => part.type === "text").map((part) => part.type === "text" ? part.text : "").join("\n").slice(0, 4000);
		if (latest?.stopReason === "error" || latest?.stopReason === "aborted" || latest?.errorMessage || errors.length && !summary) throw new Error(latest?.errorMessage || errors[0] || "Resource run failed");
		return { sessionPath: created.sessionPath, status: "success", summary: summary || "(Completed)" };
	} catch (error) {
		stop();
		await waitForStop();
		return { sessionPath: created.sessionPath, status: "error", error: error instanceof Error ? error.message : "Resource run failed" };
	} finally {
		unsubscribe();
		signal.removeEventListener("abort", stop);
		await manager.disposeSessionPath(created.sessionPath);
		managed.headless = false;
	}
}
