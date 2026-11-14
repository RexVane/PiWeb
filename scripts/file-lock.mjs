import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { runtimeRequire } from "./runtime-require.mjs";
import { processIdentity, processIdentityAlive } from "./process-identity.mjs";
let native;
const sleeper = new Int32Array(new SharedArrayBuffer(4));
function api() {
	if (native) return native;
	let koffi;
	try { koffi = runtimeRequire(import.meta.url)("koffi"); }
	catch { throw new Error("Safe build/instance locking requires the optional koffi runtime. Reinstall PiWeb with optional dependencies enabled."); }
	if (process.platform === "win32") {
		const lib = koffi.load("kernel32.dll");
		native = {
			open: lib.func("void *CreateFileW(str16 path, uint32 access, uint32 share, void *security, uint32 disposition, uint32 flags, void *template)"),
			close: lib.func("bool CloseHandle(void *handle)"), error: lib.func("uint32 GetLastError()"),
		};
	} else {
		const lib = koffi.load(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6");
		native = { flock: lib.func("int flock(int fd, int operation)") };
	}
	return native;
}
/** The kernel releases this short transaction lock even after a process crash.
 * The persistent mutex file must never be unlinked: all contenders lock the same inode.
 */
function transaction(file, action) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const os = api();
	const mutex = `${file}.mutex`;
	const deadline = Date.now() + 5_000;
	let handle;
	if (os.open) {
		while (true) {
			handle = os.open(path.resolve(mutex), 0xC0000000, 0, null, 4, 0x80, null);
			if (handle !== null && BigInt(handle) !== 0xffffffffffffffffn && BigInt(handle) !== 0xffffffffn) break;
			const code = os.error();
			if (![32, 33].includes(code)) throw new Error(`Cannot open build/instance mutex (Windows error ${code})`);
			if (Date.now() >= deadline) throw new Error(`build/instance metadata is busy; retry shortly (${file})`);
			Atomics.wait(sleeper, 0, 0, 10);
		}
	} else {
		handle = fs.openSync(mutex, "a", 0o600);
		while (os.flock(handle, 2 | 4) !== 0) {
			if (Date.now() >= deadline) { fs.closeSync(handle); throw new Error(`build/instance metadata is busy; retry shortly (${file})`); }
			Atomics.wait(sleeper, 0, 0, 10);
		}
	}
	try { return action(); }
	finally { if (os.close) os.close(handle); else { os.flock(handle, 8); fs.closeSync(handle); } }
}
function readOwner(file) {
	try {
		const owner = JSON.parse(fs.readFileSync(file, "utf8"));
		if (!owner || typeof owner !== "object" || Array.isArray(owner) || !Number.isSafeInteger(owner.pid) || owner.pid <= 0
			|| (owner.children !== undefined && (!Array.isArray(owner.children) || owner.children.some((pid) => !Number.isSafeInteger(pid) || pid <= 0)))) throw new Error("invalid owner");
		return owner;
	} catch (error) {
		if (error.code === "ENOENT") return undefined;
		throw new Error(`lock is incomplete; verify its owner and archive the damaged lock before retrying (${file})`, { cause: error });
	}
}
function writeOwner(file, owner) {
	const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
	const handle = fs.openSync(temporary, "wx", 0o600);
	try { fs.writeFileSync(handle, JSON.stringify(owner)); fs.fsyncSync(handle); }
	finally { fs.closeSync(handle); }
	// Atomic replacement under the OS mutex: a crash leaves either the old or new
	// complete owner, never a half-written shared file. Orphan temps are harmless.
	fs.renameSync(temporary, file);
}
function livingChildren(owner) {
	return (owner.children ?? []).filter((pid) => processIdentityAlive(pid, owner.childBirths?.[pid]) !== false);
}
/** Serialize acquisition, reclamation, child tracking, metadata updates and release. */
export function acquireFileLock(file, metadata = {}) {
	const token = randomUUID();
	const birth = processIdentity(process.pid).birth;
	transaction(file, () => {
		const owner = readOwner(file);
		if (owner && ((!owner.released && processIdentityAlive(owner.pid, owner.birth) !== false) || livingChildren(owner).length)) {
			throw Object.assign(new Error(`an update/build or instance is already running (${file})`), { owner });
		}
		writeOwner(file, { ...metadata, pid: process.pid, birth, children: [], childBirths: {}, startedAt: new Date().toISOString(), token, released: false });
	});
	const release = () => transaction(file, () => {
		const owner = readOwner(file);
		if (!owner || owner.token !== token) return;
		if (livingChildren(owner).length) writeOwner(file, { ...owner, released: true });
		else fs.unlinkSync(file);
	});
	release.childStarted = (pid) => trackLockChild(file, token, pid);
	release.updateMetadata = (metadata) => transaction(file, () => {
		const owner = readOwner(file);
		if (!owner || owner.token !== token || owner.released) throw new Error("instance lock ownership changed");
		writeOwner(file, { ...owner, ...metadata, token, pid: owner.pid, birth: owner.birth, children: owner.children, childBirths: owner.childBirths, released: false });
	});
	release.token = token;
	release.file = path.resolve(file);
	return release;
}
export function trackLockChild(file, token, pid) {
	if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("invalid child pid");
	return transaction(file, () => {
		const owner = readOwner(file);
		if (!owner || owner.token !== token || owner.released) throw new Error("build lock ownership changed");
		writeOwner(file, { ...owner, children: [...new Set([...(owner.children ?? []), pid])], childBirths: { ...owner.childBirths, [pid]: processIdentity(pid).birth } });
	});
}
