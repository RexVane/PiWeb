import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

const inside = (child: string, parent: string) => child === parent || child.startsWith(parent.replace(/\/$/, "") + "/");

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
		const module = await import("koffi"); const koffi = module.default ?? module;
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
	// Other platforms have no native path pinning adapter here; re-resolve the
	// physical parent and fail if it has become an alias. Do not claim OS isolation.
	if (await fs.realpath(parent) !== parent) throw new Error("Removal path changed; original files were retained.");
	return action(absolute);
}
