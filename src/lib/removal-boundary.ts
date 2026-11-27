import { AsyncLocalStorage } from "node:async_hooks";
import fsSync, { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { runtimeRequire } from "../../scripts/runtime-require.mjs";

const inside = (child: string, parent: string) => child === parent || child.startsWith(parent.replace(/\/$/, "") + "/");
const darwinPinnedParents = new AsyncLocalStorage<Map<string, () => string>>();

type DarwinNative = {
	open: (path: string, oflag: number) => number;
	openat: (fd: number, path: string, oflag: number) => number;
	close: (fd: number) => number;
	fcntl: (fd: number, cmd: number, type: "void *", buf: Buffer) => number;
	errno: () => number;
};

let darwinApi: DarwinNative | undefined;
function loadDarwinNative(): DarwinNative {
	if (darwinApi) return darwinApi;
	const koffi = runtimeRequire(import.meta.url)("koffi") as typeof import("koffi");
	const libc = koffi.load("/usr/lib/libSystem.B.dylib");
	darwinApi = {
		open: libc.func("int open(const char *path, int oflag, ...)") as DarwinNative["open"],
		openat: libc.func("int openat(int fd, const char *path, int oflag, ...)") as DarwinNative["openat"],
		close: libc.func("int close(int fd)") as DarwinNative["close"],
		fcntl: libc.func("int fcntl(int fd, int cmd, ...)") as DarwinNative["fcntl"],
		errno: () => koffi.errno(),
	};
	return darwinApi;
}

function readDarwinFdPath(native: DarwinNative, fd: number): string {
	const F_GETPATH = 50;
	const buffer = Buffer.alloc(4096);
	if (native.fcntl(fd, F_GETPATH, "void *", buffer) !== 0) {
		throw new Error("Removal path changed or could not be resolved; original files were retained.");
	}
	const terminator = buffer.indexOf(0);
	return buffer.subarray(0, terminator === -1 ? buffer.length : terminator).toString("utf8");
}

function darwinOpenError(code: number, targetPath: string): Error {
	if (code === 2) return Object.assign(new Error(`ENOENT: no such file or directory, open '${targetPath}'`), { code: "ENOENT" });
	if (code === 20 || code === 62) return new Error("Removal path changed or contains a directory link; original files were retained.");
	return new Error(`Could not protect the removal path (errno ${code}); original files were retained.`);
}

/** Resolve the current path of a protected removal source without following macOS volfs limitations. */
export async function currentRemovalPath(source: string): Promise<string> {
	const resolver = darwinPinnedParents.getStore()?.get(source);
	return resolver ? resolver() : source;
}

/** Resolve the canonical target path for a protected removal source. */
export async function canonicalRemovalSource(source: string): Promise<string> {
	return fs.realpath(await currentRemovalPath(source));
}

/** mountinfo, unlike st_dev alone, also identifies same-filesystem bind mounts. */
export function removalMounts(mountInfo: string, target: string, root = target): string[] {
	return mountInfo.split("\n").flatMap((line) => {
		const encoded = line.split(" ")[4];
		if (!encoded) return [];
		const mount = encoded.replace(/\\([0-7]{3})/g, (_, code: string) => String.fromCharCode(parseInt(code, 8)));
		return inside(mount, root) && (inside(mount, target) || inside(target, mount)) ? [mount] : [];
	});
}

export async function assertNoRemovalMounts(target: string, root = target): Promise<void> {
	if (process.platform !== "linux") return;
	if (removalMounts(await fs.readFile("/proc/self/mountinfo", "utf8"), target, root).length) {
		throw new Error("This skill contains or crosses a mounted directory; unmount it before removal. Original files were retained.");
	}
}

/** Pin physical ancestors, then operate on that path for the entire removal. */
export async function withProtectedRemovalSource<T>(target: string, action: (source: string) => Promise<T>): Promise<T> {
	const absolute = path.resolve(target);
	const parent = path.dirname(absolute);
	const volume = path.parse(absolute).root;
	if (process.platform === "win32") {
		// Resolve the native loader on the installed machine, including for Linux-built npm packages.
		const koffi = runtimeRequire(import.meta.url)("koffi") as typeof import("koffi");
		const kernel = koffi.load("kernel32.dll");
		const create = kernel.func("void *CreateFileW(str16 name, uint32 access, uint32 share, void *security, uint32 disposition, uint32 flags, void *templateFile)");
		const info = kernel.func("bool GetFileInformationByHandle(void *file, void *information)");
		const close = kernel.func("bool CloseHandle(void *handle)");
		const handles: unknown[] = [];
		const pin = (directory: string) => {
			// FILE_LIST_DIRECTORY is necessary for Windows sharing checks. No write
			// or delete sharing prevents ancestor rename/reparse replacement.
			const handle = create(directory, 0x81, 0x1, null, 3, 0x02000000 | 0x00200000, null);
			if (!handle || BigInt(typeof handle === "number" || typeof handle === "bigint" ? handle : koffi.address(handle)) === 0xffffffffffffffffn) throw new Error("Could not protect the removal path; close programs moving it and retry.");
			handles.push(handle);
			const data = Buffer.alloc(52);
			if (!info(handle, data) || !(data.readUInt32LE(0) & 0x10) || (data.readUInt32LE(0) & 0x400)) throw new Error("Removal path changed or contains a directory link; original files were retained.");
		};
		try {
			let directory = volume; pin(directory);
			for (const segment of path.relative(volume, parent).split(path.sep).filter(Boolean)) { directory = path.join(directory, segment); pin(directory); }
			return await action(absolute);
		} finally { for (const handle of handles.reverse()) close(handle); }
	}
	if (process.platform === "linux") {
		const handles: fs.FileHandle[] = [];
		try {
			let directory = await fs.open(volume, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); handles.push(directory);
			for (const segment of path.relative(volume, parent).split(path.sep).filter(Boolean)) {
				directory = await fs.open(`/proc/self/fd/${directory.fd}/${segment}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); handles.push(directory);
			}
			return await action(`/proc/self/fd/${directory.fd}/${path.basename(absolute)}`);
		} finally { for (const handle of handles.reverse()) await handle.close(); }
	}
	if (process.platform === "darwin") {
		const native = loadDarwinNative();
		const O_RDONLY = 0x0000;
		const O_NOFOLLOW = 0x0100;
		const O_DIRECTORY = 0x100000;
		const flags = O_RDONLY | O_DIRECTORY | O_NOFOLLOW;
		const handles: number[] = [];
		try {
			let fd = native.open(volume, flags);
			if (fd < 0) throw darwinOpenError(native.errno(), volume);
			handles.push(fd);
			for (const segment of path.relative(volume, parent).split(path.sep).filter(Boolean)) {
				fd = native.openat(fd, segment, flags);
				if (fd < 0) throw darwinOpenError(native.errno(), parent);
				handles.push(fd);
			}
			if (readDarwinFdPath(native, fd) !== parent) {
				throw new Error("Removal path changed; original files were retained.");
			}
			const stat = fsSync.fstatSync(fd, { bigint: true });
			const volParent = `/.vol/${stat.dev}/${stat.ino}`;
			if (!(await fs.lstat(volParent)).isDirectory()) {
				throw new Error("Could not protect the removal path; original files were retained.");
			}
			const basename = path.basename(absolute);
			const source = `${volParent}/${basename}`;
			const pinned = new Map(darwinPinnedParents.getStore());
			pinned.set(source, () => path.join(readDarwinFdPath(native, fd), basename));
			return await darwinPinnedParents.run(pinned, () => action(source));
		} finally {
			for (const handle of handles.reverse()) native.close(handle);
		}
	}
	// Other platforms have no native path pinning adapter here; re-resolve the
	// physical parent and fail if it has become an alias. Do not claim OS isolation.
	if (await fs.realpath(parent) !== parent) throw new Error("Removal path changed; original files were retained.");
	return action(absolute);
}
