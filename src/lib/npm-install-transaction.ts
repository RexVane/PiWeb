import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { runtimeRequire } from "../../scripts/runtime-require.mjs";
import { processIdentity } from "../../scripts/process-identity.mjs";
import { readJsoncSettingsObjectSync, mutateJsoncSettingsFileSync } from "./jsonc-settings-storage";
import { syncDirectorySync } from "./atomic-file";
import { assertNoRemovalMounts } from "./removal-boundary";
import { windowsDirectoryApiSync } from "./windows-directory-api";

type Fields = { packages?: unknown; disabledPackages?: unknown };
export interface NpmTransactionPlan {
	root: string;
	projectRoot?: string;
	settings?: { file: string; projectRoot?: string; after: Fields };
}
interface Journal {
	version: 1; id: string; pid: number; birth?: string | null;
	phase: "working" | "rolling-back" | "committing" | "committed";
	hadOriginal: boolean; originalStamp?: string;
	settings?: { before: Fields; after: Fields };
	settingsStarted?: boolean;
	project?: boolean;
	group?: { id: string; file: string };
}
interface GroupDecision { version: 1; id: string; decision: "working" | "commit" | "completed" | "rollback"; roots: string[]; members: Record<string, string> }
export class NpmTransactionCommittedError extends Error { readonly applied = true; }
export class NpmTransactionPendingCommitError extends Error { readonly pending = true; }
interface Transaction {
	root: string; stage: string; previous: string; file: string;
	requestedRoot: string; projectRoot?: string;
	journal: Journal; snapshot: string;
	settings?: NpmTransactionPlan["settings"];
}
const context = new AsyncLocalStorage<Map<string, Transaction>>();
const active = new Set<string>();
const recoveringGroups = new Set<string>();
const MARKER = ".piweb-npm-generation.json";
const JOURNAL = "piweb-npm-transaction.json";
const keyOf = (file: string) => process.platform === "win32" ? path.resolve(file).toLowerCase() : path.resolve(file);
const inside = (file: string, root: string) => { const rel = path.relative(root, file); return rel === "" || (rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel)); };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const fields = (value: Record<string, unknown>): Fields => ({ ...(Object.hasOwn(value, "packages") ? { packages: value.packages } : {}), ...(Object.hasOwn(value, "disabledPackages") ? { disabledPackages: value.disabledPackages } : {}) });
function rename(source: string, destination: string): void {
	if (process.platform === "win32" && path.dirname(source) === path.dirname(destination)) windowsDirectoryApiSync().rename(source, path.basename(destination), !stat(source)?.isDirectory());
	else fs.renameSync(source, destination);
}
function pinParent(root: string): () => void {
	const parent = path.dirname(root);
	if (process.platform !== "win32") {
		if (keyOf(fs.realpathSync(parent)) !== keyOf(parent)) throw new Error("Plugin installation parent changed; original files were retained.");
		return () => {};
	}
	const api = windowsDirectoryApiSync(), handles: unknown[] = [];
	try {
		let current = path.parse(root).root;
		handles.push(api.pin(current));
		for (const part of path.relative(current, parent).split(path.sep).filter(Boolean)) { current = path.join(current, part); handles.push(api.pin(current)); }
		return () => { for (const handle of handles.reverse()) api.close(handle); };
	} catch (error) { for (const handle of handles.reverse()) api.close(handle); throw error; }
}
function protectParent<T>(root: string, action: () => T): T {
	const release = pinParent(root);
	try { return action(); } finally { release(); }
}
function prepareParent(plan: NpmTransactionPlan): { root: string; release: () => void } {
	let parent = path.dirname(path.resolve(plan.root));
	if (plan.projectRoot) {
		const project = fs.realpathSync(plan.projectRoot);
		if (keyOf(parent) !== keyOf(path.join(path.resolve(plan.projectRoot), ".pi"))) throw new Error("Invalid project plugin prefix.");
		parent = path.join(project, ".pi");
	} else {
		const suffix: string[] = [];
		while (!stat(parent)) { suffix.unshift(path.basename(parent)); parent = path.dirname(parent); }
		parent = path.join(fs.realpathSync(parent), ...suffix);
	}
	const root = path.join(parent, "npm");
	if (process.platform !== "win32") {
		fs.mkdirSync(parent, { recursive: true });
		return { root, release: pinParent(root) };
	}
	const api = windowsDirectoryApiSync(), handles: unknown[] = [];
	try {
		let current = path.parse(root).root;
		handles.push(api.pin(current));
		for (const part of path.relative(current, parent).split(path.sep).filter(Boolean)) {
			current = path.join(current, part);
			if (!stat(current)) fs.mkdirSync(current);
			handles.push(api.pin(current));
		}
		return { root, release: () => { for (const handle of handles.reverse()) api.close(handle); } };
	} catch (error) { for (const handle of handles.reverse()) api.close(handle); throw error; }
}
/** Kernel ownership survives awaits and is released even if the installer crashes. */
function acquireTransactionLock(root: string): () => void {
	const file = path.join(path.dirname(root), "piweb-npm-transaction.mutex");
	const existing = stat(file);
	if (existing && (!existing.isFile() || existing.isSymbolicLink() || existing.nlink > 1)) throw new Error("Plugin transaction mutex must be a regular private file.");
	const koffi = runtimeRequire(import.meta.url)("koffi") as typeof import("koffi");
	if (process.platform === "win32") {
		const kernel = koffi.load("kernel32.dll");
		const create = kernel.func("void *CreateFileW(str16 name, uint32 access, uint32 share, void *security, uint32 disposition, uint32 flags, void *templateFile)");
		const close = kernel.func("bool CloseHandle(void *handle)");
		const handle = create(file, 0xc0000000, 0, null, 4, 0x00200000, null);
		if (!handle || BigInt(typeof handle === "number" || typeof handle === "bigint" ? handle : koffi.address(handle)) === 0xffffffffffffffffn) throw Object.assign(new Error("Another plugin installation is running; retry after it finishes."), { code: "EBUSY" });
		return () => { close(handle); };
	}
	const flock = koffi.load(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6").func("int flock(int fd, int operation)");
	const fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600);
	if (flock(fd, 2 | 4) !== 0) { fs.closeSync(fd); throw Object.assign(new Error("Another plugin installation is running; retry after it finishes."), { code: "EBUSY" }); }
	return () => { flock(fd, 8); fs.closeSync(fd); };
}
function stat(file: string): fs.Stats | undefined {
	try { return fs.lstatSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
function stamp(file: string): string | undefined {
	try { const value = fs.lstatSync(file, { bigint: true }); return `${value.dev}:${value.ino}`; }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
function atomicJson(file: string, value: unknown): void {
	const temporary = `${file}.${randomUUID()}.tmp`;
	const fd = fs.openSync(temporary, "wx", 0o600);
	try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); }
	finally { fs.closeSync(fd); }
	// no-unsafe-finally：finally 里不能再 throw/return；把清理与主操作的错误分开记录，
	// 清理失败仍按原语义优先抛出（和原先 finally 覆盖主错误一致）。
	let writeError: unknown;
	try { rename(temporary, file); }
	catch (error) { writeError = error; }
	let cleanupError: unknown;
	try { fs.unlinkSync(temporary); }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") cleanupError = error; }
	if (cleanupError !== undefined) throw cleanupError;
	if (writeError !== undefined) throw writeError;
	// 目录项持久化：断电后恢复日志/安装标记必须真实存在（不可用时安全降级）。
	syncDirectorySync(path.dirname(file));
}
function readJournal(root: string): Journal | undefined {
	const file = path.join(path.dirname(root), JOURNAL);
	const metadata = stat(file);
	if (!metadata) return undefined;
	if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink > 1 || metadata.size > 4 * 1024 * 1024) throw new Error("Plugin installation recovery record is unsafe; the existing installation was retained.");
	const value = JSON.parse(fs.readFileSync(file, "utf8")) as Journal;
	if (value.version !== 1 || !/^[a-f0-9-]{36}$/.test(value.id) || !Number.isSafeInteger(value.pid)
		|| !["working", "rolling-back", "committing", "committed"].includes(value.phase) || typeof value.hadOriginal !== "boolean"
		|| (value.settings && (!value.settings.before || !value.settings.after))) throw new Error("Plugin installation recovery record is invalid; the existing installation was retained.");
	return value;
}
function groupDecision(journal: Journal, allowed?: Set<string>): GroupDecision | undefined {
	if (!journal.group) return undefined;
	const { id, file } = journal.group;
	if (!/^[a-f0-9-]{36}$/.test(id) || path.basename(file) !== `piweb-npm-group-${id}.json`) throw new Error("Plugin group recovery record is invalid.");
	if (allowed && !allowed.has(keyOf(path.join(path.dirname(file), "npm")))) throw new Error("Plugin recovery coordinator is outside the authorized installation scopes.");
	safeDirectory(path.dirname(file));
	return protectParent(file, () => {
	const info = stat(file);
	if (!info?.isFile() || info.isSymbolicLink() || info.nlink > 1 || info.size > 64 * 1024) throw new Error("Plugin group recovery decision is unavailable; all installation files were retained.");
	const value = JSON.parse(fs.readFileSync(file, "utf8")) as GroupDecision;
	if (value.version !== 1 || value.id !== id || !["working", "commit", "completed", "rollback"].includes(value.decision)
		|| !Array.isArray(value.roots) || value.roots.length > 2 || !value.members || value.roots.some((root) => typeof root !== "string" || !path.isAbsolute(root) || path.basename(root) !== "npm" || !/^[a-f0-9-]{36}$/.test(value.members[keyOf(root)] ?? ""))) throw new Error("Plugin group recovery record is invalid.");
	if (allowed && value.roots.some((root) => !allowed.has(keyOf(root)))) throw new Error("Plugin recovery includes another workspace; reopen the original workspace to complete it. All installation files were retained.");
	return value;
	});
}
function clearGroupIfComplete(journal: Journal, decision: GroupDecision | undefined): void {
	if (decision && decision.roots.every((root) => !stat(path.join(path.dirname(root), JOURNAL)))) {
		safeDirectory(path.dirname(journal.group!.file));
		protectParent(journal.group!.file, () => fs.unlinkSync(journal.group!.file));
	}
}
function marker(root: string): string | undefined {
	try { const value = JSON.parse(fs.readFileSync(path.join(root, MARKER), "utf8")); return typeof value.id === "string" ? value.id : undefined; }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return undefined; throw error; }
}
function paths(root: string, id: string) {
	const parent = path.dirname(root);
	return { root, stage: path.join(parent, `npm-stage-${id}`), previous: path.join(parent, `npm-previous-${id}`), file: path.join(parent, JOURNAL) };
}
function safeDirectory(file: string): void {
	const value = stat(file);
	if (value && (!value.isDirectory() || value.isSymbolicLink() || keyOf(fs.realpathSync(file)) !== keyOf(file))) throw new Error("Plugin installation directory must be physical; no installation was changed.");
}
function writeRecoveryIndex(tx: Pick<Transaction, "root" | "stage" | "previous" | "journal">, reason: string): void {
	const directory = path.join(path.dirname(tx.root), "backups");
	fs.mkdirSync(directory, { recursive: true });
	if (keyOf(fs.realpathSync(directory)) !== keyOf(directory)) throw new Error("Plugin recovery index directory must not be linked.");
	const retained = [tx.previous, tx.stage].filter((file) => stat(file));
	if (retained.length) {
		const file = path.join(directory, "INDEX.md");
		protectParent(file, () => {
			const initial = stat(file);
			if (initial && (!initial.isFile() || initial.isSymbolicLink() || initial.nlink > 1)) throw new Error("Plugin recovery index must not be linked; recovery files were retained.");
			const flags = fs.constants.O_APPEND | fs.constants.O_WRONLY | fs.constants.O_NONBLOCK | (initial ? 0 : fs.constants.O_CREAT | fs.constants.O_EXCL) | (process.platform === "win32" ? 0 : fs.constants.O_NOFOLLOW);
			const fd = fs.openSync(file, flags, 0o600);
			try {
				const opened = fs.fstatSync(fd, { bigint: true }), current = fs.lstatSync(file, { bigint: true });
				if (!opened.isFile() || !current.isFile() || current.isSymbolicLink() || opened.nlink !== 1n || current.nlink !== 1n || opened.ino !== current.ino || opened.dev !== current.dev || keyOf(fs.realpathSync(file)) !== keyOf(file)) throw new Error("Plugin recovery index changed while opening; no index data was written.");
				fs.writeFileSync(fd, `${new Date().toISOString()} | ${tx.root.replace(/[\r\n|]/g, " ")} | ${retained.join(", ").replace(/[\r\n|]/g, " ")} | ${reason}\n`, "utf8");
				fs.fsyncSync(fd);
			} finally { fs.closeSync(fd); }
		});
	}
}
function restoreSettings(root: string, journal: Journal, projectRoot?: string): void {
	if (!journal.settings || !journal.settingsStarted) return;
	const file = path.join(path.dirname(root), "settings.json");
	mutateJsoncSettingsFileSync(file, (current) => {
		let changed = false;
		for (const field of ["packages", "disabledPackages"] as const) {
			const before = journal.settings!.before[field], after = journal.settings!.after[field];
			if (same(before, after) || same(current[field], before)) continue;
			if (!same(current[field], after)) throw new Error("Plugin settings changed during recovery. The old installation and recovery files were retained; reconcile the package list before retrying.");
			if (Object.hasOwn(journal.settings!.before, field)) current[field] = before; else delete current[field];
			changed = true;
		}
		return changed ? current : undefined;
	}, { projectRoot });
}
function finishPromotion(tx: Pick<Transaction, "root" | "stage" | "previous" | "file" | "journal">): void {
	for (const directory of [tx.root, tx.stage, tx.previous]) safeDirectory(directory);
	if (marker(tx.root) !== tx.journal.id) {
		if (marker(tx.stage) !== tx.journal.id) throw new Error("Prepared plugin installation is unavailable; original installation and recovery files were retained.");
		if (stat(tx.root)) {
			if (stat(tx.previous) || stamp(tx.root) !== tx.journal.originalStamp) throw new Error("Plugin installation changed during promotion; recovery files were retained.");
			rename(tx.root, tx.previous);
		}
		rename(tx.stage, tx.root);
	}
	tx.journal.phase = "committed";
	atomicJson(tx.file, tx.journal);
}

/** Called by SDK path resolution, before a stale transaction can expose a partial tree. */
export function recoverNpmPrefix(root: string, projectRoot?: string, allowedScopes: Array<Pick<NpmTransactionPlan, "root" | "projectRoot">> = [{ root, projectRoot }]): boolean {
	root = path.resolve(root);
	if (path.basename(root) !== "npm") throw new Error("Invalid managed npm prefix.");
	if (projectRoot) {
		if (!stat(projectRoot)) return false;
		const expected = path.join(fs.realpathSync(projectRoot), ".pi", "npm");
		if (keyOf(root) !== keyOf(path.join(path.resolve(projectRoot), ".pi", "npm")) && keyOf(root) !== keyOf(expected)) throw new Error("Invalid project plugin recovery path.");
		root = expected;
		const parent = stat(path.dirname(root));
		if (!parent) return false;
		if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error("Project plugin directory must not be linked.");
	} else {
		if (!stat(path.dirname(root))) return false;
		root = path.join(fs.realpathSync(path.dirname(root)), "npm");
	}
	if (!stat(path.join(path.dirname(root), JOURNAL))) return false;
	const unpin = pinParent(root);
	let release: (() => void) | undefined;
	try {
		const journal = readJournal(root);
		if (!journal || active.has(keyOf(root))) return false;
		const allowed = new Set(allowedScopes.map((scope) => {
			if (scope.projectRoot) return keyOf(path.join(stat(scope.projectRoot) ? fs.realpathSync(scope.projectRoot) : path.resolve(scope.projectRoot), ".pi", "npm"));
			const parent = path.dirname(path.resolve(scope.root));
			return keyOf(stat(parent) ? path.join(fs.realpathSync(parent), "npm") : scope.root);
		}));
		groupDecision(journal, allowed);
		try { release = acquireTransactionLock(root); }
		catch (error) {
			const decision = groupDecision(journal, allowed)?.decision;
			if ((error as NodeJS.ErrnoException).code === "EBUSY" && journal.phase === "working" && (!decision || decision === "working")) return false;
			throw error;
		}
		const current = readJournal(root);
		if (!current) return false;
		const tx = { ...paths(root, current.id), journal: current };
		const decision = groupDecision(current, allowed);
		if (decision && (!decision.roots.some((member) => keyOf(member) === keyOf(root)) || decision.members[keyOf(root)] !== current.id)) throw new Error("Plugin recovery group does not include this installation generation.");
		if (decision && !recoveringGroups.has(decision.id)) {
			recoveringGroups.add(decision.id);
			try {
				for (const peer of decision.roots.filter((member) => keyOf(member) !== keyOf(root)).sort()) {
					safeDirectory(path.dirname(peer));
					const peerJournal = readJournal(peer);
					if (peerJournal) {
						if (peerJournal.id !== decision.members[keyOf(peer)] || peerJournal.group?.id !== decision.id || peerJournal.group.file !== current.group!.file) throw new Error("Plugin recovery group changed; installation files were retained.");
						const authorized = allowedScopes.find((scope) => {
							const parent = path.dirname(scope.root);
							const canonical = scope.projectRoot ? path.join(fs.realpathSync(scope.projectRoot), ".pi", "npm") : path.join(fs.realpathSync(parent), "npm");
							return keyOf(canonical) === keyOf(peer);
						});
						if (!authorized) throw new Error("Plugin recovery scope is no longer authorized.");
						recoverNpmPrefix(peer, authorized.projectRoot, allowedScopes);
					} else if (decision.decision === "commit" && marker(peer) !== decision.members[keyOf(peer)]) throw new Error("A prepared plugin scope is missing; recovery was retained for retry.");
				}
			} finally { recoveringGroups.delete(decision.id); }
		}
		const commit = decision ? decision.decision === "commit" || decision.decision === "completed" : current.phase === "committing" || current.phase === "committed";
		protectParent(root, () => {
		if (!commit) {
			if (current.phase === "rolling-back" || marker(root) === current.id || stat(tx.previous)) {
				if (marker(root) === current.id) { if (stat(tx.stage)) throw new Error("Plugin staging path changed; all recovery files were retained."); rename(root, tx.stage); }
				if (stat(tx.previous) && !stat(root)) rename(tx.previous, root);
			}
			restoreSettings(root, current, projectRoot);
		}
		else finishPromotion(tx);
		writeRecoveryIndex(tx, !commit ? "Interrupted plugin operation; original installation retained" : "Previous plugin installation retained after recovered commit");
		fs.unlinkSync(tx.file);
		clearGroupIfComplete(current, decision);
		});
		return true;
	} finally { release?.(); unpin(); }
}

/** An operation-local mapping; unrelated loaders continue to see the old live tree. */
export function npmTransactionPath(file: string): string {
	for (const tx of context.getStore()?.values() ?? []) for (const root of [tx.root, tx.requestedRoot]) if (inside(path.resolve(file), root)) return path.join(tx.stage, path.relative(root, file));
	return file;
}

/** Check immediately before the SDK changes its package array, after slow npm I/O. */
export function beginNpmSettingsWrite(root: string): void {
	const tx = [...context.getStore()?.values() ?? []].find((entry) => keyOf(entry.root) === keyOf(root) || keyOf(entry.requestedRoot) === keyOf(root));
	if (!tx?.settings || !tx.journal.settings || tx.journal.settingsStarted) return;
	const current = fields(readJsoncSettingsObjectSync(tx.settings.file, { projectRoot: tx.settings.projectRoot }));
	if (!same(current, tx.journal.settings.before)) throw new Error("Plugin settings changed while installation was being prepared; reload and retry. Existing installation was retained.");
	tx.journal.settingsStarted = true;
	atomicJson(tx.file, tx.journal);
}

async function digest(file: string): Promise<string> {
	const hash = createHash("sha256");
	const stream = fs.createReadStream(file);
	for await (const chunk of stream) hash.update(chunk);
	return hash.digest("hex");
}
/** Never dereference links or traverse beyond this managed npm prefix. */
async function treeSnapshot(root: string, copyTo?: string): Promise<string> {
	if (!stat(root)) return "missing";
	safeDirectory(root);
	await assertNoRemovalMounts(root);
	const hash = createHash("sha256");
	let entries = 0, bytes = 0;
	const visit = async (file: string, relative: string): Promise<void> => {
		if (++entries > 300_000) throw new Error("Plugin installation contains too many files to copy safely; the existing installation was retained.");
		const value = await fsp.lstat(file);
		const destination = copyTo ? path.join(copyTo, relative) : undefined;
		if (value.isSymbolicLink()) {
			const link = await fsp.readlink(file);
			hash.update(JSON.stringify([relative, "link", link]));
			if (destination) {
				const resolved = path.resolve(path.dirname(file), link);
				const mapped = inside(resolved, root) ? path.join(copyTo!, path.relative(root, resolved)) : resolved;
				const directory = await fsp.stat(file).then((item) => item.isDirectory(), () => false);
				const target = process.platform === "win32" && directory ? mapped : path.relative(path.dirname(destination), mapped);
				await fsp.symlink(target, destination, process.platform === "win32" && directory ? "junction" : directory ? "dir" : "file");
			}
		} else if (value.isDirectory()) {
			hash.update(JSON.stringify([relative, "directory", value.mode]));
			if (destination) await fsp.mkdir(destination, { mode: value.mode });
			for (const child of (await fsp.readdir(file)).sort()) await visit(path.join(file, child), path.join(relative, child));
		} else if (value.isFile()) {
			bytes += value.size;
			if (bytes > 20 * 1024 ** 3) throw new Error("Plugin installation exceeds the safe copy size; the existing installation was retained.");
			const content = await digest(file);
			hash.update(JSON.stringify([relative, "file", value.mode, value.size, content]));
			if (destination) {
				await fsp.copyFile(file, destination, fs.constants.COPYFILE_EXCL);
				await fsp.chmod(destination, value.mode);
				if (await digest(destination) !== content) throw new Error("Plugin installation changed while copying; retry the operation.");
			}
		} else throw new Error("Plugin installation contains a special file; the existing installation was retained.");
	};
	await visit(root, "");
	return hash.digest("hex");
}

async function finalizeLinks(tx: Transaction): Promise<void> {
	const visit = async (directory: string) => {
		for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
			const file = path.join(directory, entry.name);
			if (entry.isSymbolicLink()) {
				const link = await fsp.readlink(file), resolved = path.resolve(path.dirname(file), link);
				if (!inside(resolved, tx.stage) || !path.isAbsolute(link)) continue;
				const isDirectory = await fsp.stat(file).then((item) => item.isDirectory(), () => false);
				await fsp.unlink(file);
				await fsp.symlink(process.platform === "win32" && isDirectory ? path.join(tx.root, path.relative(tx.stage, resolved)) : path.relative(path.dirname(file), resolved), file, process.platform === "win32" && isDirectory ? "junction" : isDirectory ? "dir" : "file");
			} else if (entry.isDirectory()) await visit(file);
		}
	};
	await visit(tx.stage);
}

/** Retain old and failed trees for recovery; no user plugin is deleted on failure. */
export async function withNpmInstallTransaction<T>(plans: NpmTransactionPlan[], operation: () => Promise<T>): Promise<T> {
	if (context.getStore()) throw new Error("Nested plugin installation transactions are not supported.");
	const transactions: Transaction[] = [];
	const releases: Array<() => void> = [];
	let group: { file: string; value: GroupDecision } | undefined;
	let completed = false;
	let commitDecided = false;
	try {
		for (const plan of [...plans].sort((a, b) => keyOf(a.root).localeCompare(keyOf(b.root)))) {
			if (path.basename(plan.root) !== "npm") throw new Error("Invalid managed npm prefix.");
			const parent = path.dirname(path.resolve(plan.root));
			const prepared = prepareParent(plan), root = prepared.root;
			releases.push(prepared.release);
			if (plan.projectRoot) readJsoncSettingsObjectSync(path.join(path.dirname(root), "settings.json"), { projectRoot: path.dirname(path.dirname(root)) });
			recoverNpmPrefix(root, plan.projectRoot ? path.dirname(path.dirname(root)) : undefined, plans);
			releases.push(acquireTransactionLock(root));
			const id = randomUUID();
			const journal: Journal = { version: 1, id, pid: process.pid, birth: processIdentity(process.pid).birth, phase: "working", hadOriginal: !!stat(root), originalStamp: stamp(root), ...(plan.projectRoot ? { project: true } : {}) };
			if (!group) {
				const groupId = randomUUID();
				group = { file: path.join(path.dirname(root), `piweb-npm-group-${groupId}.json`), value: { version: 1, id: groupId, decision: "working", roots: [], members: {} } };
			}
			group.value.roots.push(root);
			group.value.members[keyOf(root)] = id;
			atomicJson(group.file, group.value);
			journal.group = { file: group.file, id: group.value.id };
			if (plan.settings) {
				if (keyOf(plan.settings.file) !== keyOf(path.join(parent, "settings.json"))) throw new Error("Invalid plugin settings transaction path.");
				journal.settings = { before: fields(readJsoncSettingsObjectSync(path.join(path.dirname(root), "settings.json"), { projectRoot: plan.projectRoot ? path.dirname(path.dirname(root)) : undefined })), after: plan.settings.after };
			}
			const canonicalSettings = plan.settings ? { ...plan.settings, file: path.join(path.dirname(root), "settings.json"), projectRoot: plan.projectRoot ? path.dirname(path.dirname(root)) : undefined } : undefined;
			const tx: Transaction = { ...paths(root, id), requestedRoot: path.resolve(plan.root), projectRoot: plan.projectRoot, journal, snapshot: "missing", settings: canonicalSettings };
			transactions.push(tx);
			active.add(keyOf(root));
			atomicJson(tx.file, journal);
			if (journal.hadOriginal) tx.snapshot = await treeSnapshot(root, tx.stage);
			else await fsp.mkdir(tx.stage);
			atomicJson(path.join(tx.stage, MARKER), { id });
		}
		const result = await context.run(new Map(transactions.map((tx) => [keyOf(tx.root), tx])), operation);
		for (const tx of transactions) {
			if (await treeSnapshot(tx.root) !== tx.snapshot) throw new Error("Installed plugin files changed during the operation; original files were retained. Retry after the other writer finishes.");
			if (tx.journal.settings && !same(fields(readJsoncSettingsObjectSync(tx.settings!.file, { projectRoot: tx.settings!.projectRoot })), tx.journal.settings.after)) throw new Error("Plugin settings were not persisted; original installation was retained.");
			await finalizeLinks(tx);
		}
		// One durable decision covers every scope before any live directory moves.
		// Recovery therefore finishes all prepared scopes after a process crash.
		if (group) { group.value.decision = "commit"; atomicJson(group.file, group.value); commitDecided = true; }
		for (const tx of transactions) {
			protectParent(tx.root, () => {
				tx.journal.phase = "committing";
				atomicJson(tx.file, tx.journal);
				finishPromotion(tx);
			});
		}
		for (const tx of transactions) {
			writeRecoveryIndex(tx, "Previous plugin installation retained after successful commit");
		}
		if (group) { group.value.decision = "completed"; atomicJson(group.file, group.value); }
		completed = true;
		for (const tx of transactions) fs.unlinkSync(tx.file);
		if (group) fs.unlinkSync(group.file);
		return result;
	} catch (error) {
		if (completed) throw new NpmTransactionCommittedError("插件更改已生效，但恢复记录尚未清理完成；刷新列表时会继续处理。", { cause: error });
		if (commitDecided) throw new NpmTransactionPendingCommitError("插件已经准备好，但提交尚未完成。请刷新插件列表继续恢复；旧安装仍保留。", { cause: error });
		const recoveryErrors: unknown[] = [];
		if (group) {
			try { group.value.decision = "rollback"; atomicJson(group.file, group.value); }
			catch (failure) { throw new AggregateError([error, failure], "Plugin commit recovery is pending; all original and prepared installations were retained."); }
		}
		for (const tx of transactions.reverse()) {
			try {
				protectParent(tx.root, () => {
				tx.journal.phase = "rolling-back";
				atomicJson(tx.file, tx.journal);
				if (marker(tx.root) === tx.journal.id) { if (stat(tx.stage)) throw new Error("Plugin staging path changed; all recovery files were retained."); rename(tx.root, tx.stage); }
				if (stat(tx.previous) && !stat(tx.root)) rename(tx.previous, tx.root);
				restoreSettings(tx.root, tx.journal, tx.settings?.projectRoot);
				writeRecoveryIndex(tx, "Failed plugin operation; original installation retained");
				fs.unlinkSync(tx.file);
				});
			} catch (failure) { recoveryErrors.push(failure); }
		}
		if (recoveryErrors.length) throw new AggregateError([error, ...recoveryErrors], "Plugin operation failed; recovery files and the old installation were retained. Retry to finish recovery.");
		if (group) fs.unlinkSync(group.file);
		throw error;
	} finally {
		for (const tx of transactions) active.delete(keyOf(tx.root));
		for (const release of releases.reverse()) release();
	}
}
