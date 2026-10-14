import { buildSnapshot } from "../agent-manager";
import { BoundaryError } from "../path-security";
import type { WebEvent, WebMessage, WebSnapshot } from "../types";
import { configureSideRuntime, disposeSideRuntime, getSideRuntime, refreshSideBackground, sideEntries, type SideRuntime } from "./runtime";
import type { SideChatProgress, SideChatRequest } from "./types";

const IDLE_MS = 10 * 60_000;
const RUN_MS = 60 * 60_000;
const MAX_RUNNING = 8;
interface SideChatJob {
	progress: SideChatProgress;
	controller: AbortController;
	listeners: Set<() => void>;
	lastSeen: number;
	versions: Map<number, { text: string; seq: number }>;
	frames: { seq: number; event: WebEvent }[];
	runtime?: SideRuntime;
	threadId: string;
	snapshot?: WebSnapshot;
	snapshotRevision: number;
	publishedSeq: number;
	publishTimer?: ReturnType<typeof setTimeout>;
	finished: Promise<void>;
	finish: () => void;
}
const globalJobs = globalThis as typeof globalThis & { __piWebFullSideChatJobs?: Map<string, SideChatJob>; __piWebFullSideChatStops?: Map<string, number>; __piWebFullSideChatRuns?: Map<string, string> };
const jobs = globalJobs.__piWebFullSideChatJobs ??= new Map();
const stopped = globalJobs.__piWebFullSideChatStops ??= new Map();
const running = globalJobs.__piWebFullSideChatRuns ??= new Map();
const keyOf = (path: string, id: string) => path + "\0" + id;

function reapJobs(): void {
	const now = Date.now();
	for (const [key, job] of jobs) {
		if (now - job.lastSeen <= IDLE_MS) continue;
		job.controller.abort();
		if (job.publishTimer) clearTimeout(job.publishTimer);
		for (const notify of job.listeners) notify();
		jobs.delete(key);
	}
	for (const [key, until] of stopped) if (until < now) stopped.delete(key);
}
function publish(job: SideChatJob, terminal = false): void {
	if (job.publishTimer) { if (!terminal) return; clearTimeout(job.publishTimer); }
	const flush = () => {
		job.publishTimer = undefined;
		job.publishedSeq = job.runtime?.managed.seq ?? 0;
		job.progress = { ...job.progress, revision: job.progress.revision + 1, contextTruncated: job.runtime?.contextTruncated || job.progress.contextTruncated };
		job.versions.set(job.progress.revision, { text: job.progress.text, seq: job.publishedSeq });
		while (job.versions.size > 8) job.versions.delete(job.versions.keys().next().value!);
		for (const notify of job.listeners) notify();
	};
	if (terminal) flush(); else job.publishTimer = setTimeout(flush, 80);
}
function settle(job: SideChatJob, update: Partial<SideChatProgress>): void {
	if (job.progress.done) return;
	job.progress = { ...job.progress, ...update, activeTool: null, done: true };
	publish(job, true);
}
const messageText = (message: WebMessage) => message.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n\n");

/** All execution and events belong to an independent, browser-owned in-memory AgentSession. */
export function startSideChat(sessionPath: string, request: SideChatRequest): SideChatProgress {
	reapJobs();
	const key = keyOf(sessionPath, request.requestId);
	const previous = jobs.get(key);
	if (previous) return { ...previous.progress };
	const threadKey = keyOf(sessionPath, request.threadId);
	if (running.has(threadKey)) throw new BoundaryError("this side conversation is still running");
	if ([...jobs.values()].filter((job) => !job.progress.done).length >= MAX_RUNNING) throw new BoundaryError("too many side-chat answers are running");
	let finish!: () => void;
	const finished = new Promise<void>((resolve) => { finish = resolve; });
	const job: SideChatJob = { progress: { requestId: request.requestId, revision: 0, text: "", done: false, aborted: false }, controller: new AbortController(), listeners: new Set(), lastSeen: Date.now(), versions: new Map([[0, { text: "", seq: 0 }]]), frames: [], threadId: request.threadId, snapshotRevision: -1, publishedSeq: 0, finished, finish };
	jobs.set(key, job);
	if (stopped.has(key)) { settle(job, { aborted: true }); finish(); return { ...job.progress }; }
	running.set(threadKey, request.requestId);
	void generate();
	return { ...job.progress };

	async function generate(): Promise<void> {
		const timeout = setTimeout(() => { job.controller.abort(); settle(job, { error: "side-chat request timed out" }); }, RUN_MS);
		timeout.unref();
		const texts = new Map<string, { order: number; blocks: Map<number, string> }>();
		const updateText = () => { job.progress = { ...job.progress, text: [...texts.values()].sort((a, b) => a.order - b.order).map((message) => [...message.blocks.entries()].sort(([a], [b]) => a - b).map(([, value]) => value).join("\n\n")).filter(Boolean).join("\n\n") }; };
		try {
			if (job.controller.signal.aborted) return;
			const runtime = getSideRuntime(sessionPath, request);
			job.runtime = runtime;
			runtime.publish = (event, seq) => {
				if (job.progress.done) return;
				job.frames.push({ seq, event });
				while (job.frames.length > 400) job.frames.shift();
				if (event.type === "delta" && event.kind === "text") {
					const id = event.messageId ?? "current";
					const message = texts.get(id) ?? { order: texts.size, blocks: new Map<number, string>() };
					message.blocks.set(event.contentIndex, (message.blocks.get(event.contentIndex) ?? "") + event.delta); texts.set(id, message); updateText();
				} else if (event.type === "message" && event.phase === "end" && event.message.role === "assistant") {
					const id = event.message.streamId ?? event.message.id ?? "current";
					const message = texts.get(id) ?? { order: texts.size, blocks: new Map<number, string>() };
					message.blocks = new Map([[0, messageText(event.message)]]); texts.set(id, message); updateText();
					const usage = event.message.usage;
					job.progress = { ...job.progress, ...(usage ? { usage: { input: usage.input ?? 0, output: usage.output ?? 0, cacheRead: usage.cacheRead ?? 0, cacheWrite: usage.cacheWrite ?? 0 } } : {}), lengthLimited: event.message.stopReason === "length" };
					if (event.message.stopReason === "error") job.progress = { ...job.progress, error: event.message.errorMessage ?? "model request failed" };
				} else if (event.type === "tool") job.progress = { ...job.progress, activeTool: event.state === "running" ? event.name : null };
				else if (event.type === "error") job.progress = { ...job.progress, error: event.message };
				publish(job);
			};
			const abort = () => { runtime.managed.ui?.dispose(); runtime.managed.session?.abortCompaction(); void runtime.managed.session?.abort().catch(() => undefined); if (request.kind === "prepare") disposeSideRuntime(sessionPath, request.threadId); };
			job.controller.signal.addEventListener("abort", abort, { once: true });
			try {
				await configureSideRuntime(runtime, request, sessionPath);
				if (job.controller.signal.aborted) return;
				refreshSideBackground(runtime, sessionPath);
				job.snapshot = await buildSnapshot(runtime.managed);
				job.snapshotRevision = job.progress.revision + 1;
				const session = runtime.managed.session!;
				const characters = job.snapshot.contextBreakdown?.characters;
				job.progress = { ...job.progress, model: session.model?.name, contextWindow: session.model?.contextWindow, characters: { systemPrompt: characters?.systemPrompt ?? session.systemPrompt.length, systemTools: (characters?.systemTools ?? 0) + (characters?.customTools ?? 0), background: runtime.background.length } };
				publish(job);
				if (request.kind !== "prepare") {
					if (request.retry) {
						const previousUser = runtime.managed.sm.getBranch().findLast((entry) => entry.type === "message" && entry.message.role === "user");
						if (previousUser) await session.navigateTree(previousUser.id);
					}
					await session.prompt(request.text, { images: request.images, source: "rpc" });
				}
				job.snapshot = await buildSnapshot(runtime.managed);
				job.snapshotRevision = job.progress.revision + 1;
				job.progress = { ...job.progress, entries: sideEntries(runtime), leafId: runtime.managed.sm.getLeafId() ?? undefined };
				settle(job, { aborted: job.controller.signal.aborted });
			} finally { job.controller.signal.removeEventListener("abort", abort); }
		} catch (error) {
			settle(job, { aborted: job.controller.signal.aborted, error: job.controller.signal.aborted ? undefined : error instanceof Error ? error.message : "side-chat request failed" });
		} finally {
			clearTimeout(timeout);
			if (job.runtime) {
				job.runtime.publish = undefined;
				job.runtime.lastSeen = Date.now();
				if (job.controller.signal.aborted && request.kind === "prepare") disposeSideRuntime(sessionPath, request.threadId);
			}
			if (running.get(threadKey) === request.requestId) running.delete(threadKey);
			if (!job.progress.done) settle(job, { aborted: job.controller.signal.aborted });
			finish();
		}
	}
}

function getJob(sessionPath: string, requestId: string): SideChatJob {
	reapJobs();
	const job = jobs.get(keyOf(sessionPath, requestId));
	if (!job) throw new BoundaryError("side-chat answer expired; send the question again");
	job.lastSeen = Date.now();
	if (job.runtime) job.runtime.lastSeen = Date.now();
	return job;
}

/** Batches main-conversation events into finite JSON responses for buffered mobile tunnels. */
export async function pollSideChat(sessionPath: string, requestId: string, after: number, signal: AbortSignal): Promise<SideChatProgress> {
	const job = getJob(sessionPath, requestId);
	if (!job.progress.done && job.progress.revision <= after && !signal.aborted) {
		await new Promise<void>((resolve) => {
			const finish = () => { clearTimeout(timer); job.listeners.delete(finish); signal.removeEventListener("abort", finish); resolve(); };
			const timer = setTimeout(finish, 20_000);
			job.listeners.add(finish); signal.addEventListener("abort", finish, { once: true });
			if (signal.aborted || job.progress.done || job.progress.revision > after) finish();
		});
	}
	const previous = job.versions.get(after);
	let snapshot = job.snapshot && (after < job.snapshotRevision || job.progress.done) ? job.snapshot : undefined;
	let from = previous?.seq ?? -1;
	if ((!previous || (job.frames[0] && from < job.frames[0].seq - 1)) && job.runtime?.managed.session && !job.runtime.managed.disposed) snapshot = await buildSnapshot(job.runtime.managed);
	if (snapshot) from = Math.max(from, snapshot.seq);
	const events = job.frames.filter((frame) => frame.seq > from && frame.seq <= job.publishedSeq && (frame.event.type === "extension_ui" || frame.event.type === "extension_ui_resolved")).map((frame) => frame.event);
	const delta = previous !== undefined && job.progress.text.startsWith(previous.text);
	return { ...job.progress, text: delta ? job.progress.text.slice(previous.text.length) : job.progress.text, textOffset: delta ? previous.text.length : 0, events, ...(snapshot ? { extensionUiRequests: snapshot.extensionUiRequests } : {}) };
}

export async function stopSideChat(sessionPath: string, requestId: string): Promise<{ steering: string[]; followUp: string[]; snapshot?: WebSnapshot; entries?: SideChatProgress["entries"]; leafId?: string }> {
	const key = keyOf(sessionPath, requestId);
	stopped.set(key, Date.now() + 60_000);
	const job = jobs.get(key);
	if (!job) return { steering: [], followUp: [] };
	const cleared = job.runtime?.managed.session?.clearQueue() ?? { steering: [], followUp: [] };
	job.controller.abort();
	settle(job, { aborted: true });
	await job.runtime?.managed.session?.abort().catch(() => undefined);
	await job.finished;
	if (job.runtime && !job.runtime.managed.disposed) return { ...cleared, snapshot: await buildSnapshot(job.runtime.managed), entries: sideEntries(job.runtime), leafId: job.runtime.managed.sm.getLeafId() ?? undefined };
	return cleared;
}
