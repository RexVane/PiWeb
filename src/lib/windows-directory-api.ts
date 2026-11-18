import { runtimeRequire } from "../../scripts/runtime-require.mjs";

let synchronousApi: ReturnType<typeof createDirectoryApi> | undefined;
/** SettingsManager's storage contract is synchronous; never wait on an async lock here. */
export function windowsDirectoryApiSync() {
	if (process.platform !== "win32" || process.arch !== "x64") throw new Error("Protected file writes require Windows x64.");
	return synchronousApi ??= createDirectoryApi(runtimeRequire(import.meta.url)("koffi") as typeof import("koffi"));
}

function createDirectoryApi(koffi: Pick<typeof import("koffi"), "load" | "address">) {
	const kernel = koffi.load("kernel32.dll");
	const create = kernel.func("void *CreateFileW(str16 name, uint32 access, uint32 share, void *security, uint32 disposition, uint32 flags, void *templateFile)");
	const info = kernel.func("bool GetFileInformationByHandle(void *file, void *information)");
	const close = kernel.func("bool CloseHandle(void *handle)");
	const lastError = kernel.func("uint32 GetLastError()");
	const setInformation = koffi.load("ntdll.dll").func("int32 NtSetInformationFile(void *file, void *ioStatus, void *information, uint32 length, uint32 informationClass)");
	const valid = (handle: unknown) => Boolean(handle) && BigInt(typeof handle === "number" || typeof handle === "bigint" ? handle : koffi.address(handle)) !== 0xffffffffffffffffn;
	const failure = (message: string, value: number, ntStatus = false) => Object.assign(new Error(message), {
		code: ntStatus ? ({ [0xc0000022]: "EACCES", [0xc0000043]: "EBUSY", [0xc0000056]: "EBUSY", [0xc0000034]: "ENOENT", [0xc0000035]: "EEXIST" } as Record<number, string>)[value >>> 0] ?? "EIO"
			: ({ 2: "ENOENT", 3: "ENOENT", 5: "EACCES", 32: "EBUSY", 33: "EBUSY", 80: "EEXIST", 183: "EEXIST" } as Record<number, string>)[value] ?? "EIO",
	});
	return {
		pin(directory: string): unknown {
			// Neither WRITE nor DELETE sharing: an opened ancestor cannot be renamed,
			// replaced, or turned into a reparse point while a file operation awaits I/O.
			// FILE_LIST_DIRECTORY is intentional: metadata-only handles do not
			// participate in Windows sharing checks and would not pin a rename.
			const handle = create(directory, 0x81, 0x1, null, 3, 0x02000000 | 0x00200000, null);
			if (!valid(handle)) throw new Error(`Could not protect the write directory (Windows error ${lastError()}). Close programs moving this directory and retry.`);
			try {
				const data = Buffer.alloc(52);
				if (!info(handle, data)) throw new Error(`Could not inspect the write directory (Windows error ${lastError()}).`);
				const attributes = data.readUInt32LE(0);
				if (!(attributes & 0x10) || (attributes & 0x400)) throw new Error("blocked: a write directory was replaced or is a reparse point");
				return handle;
			} catch (error) { close(handle); throw error; }
		},
		rename(temporary: string, name: string, replace = true) {
			const handle = create(temporary, 0x10000, 0x7, null, 3, 0x00200000 | 0x02000000, null);
			if (!valid(handle)) { const value = lastError(); throw failure(`Could not open the replacement file (Windows error ${value}).`, value); }
			try {
				const encoded = Buffer.from(name, "utf16le");
				const data = Buffer.alloc(24 + encoded.length);
				data[0] = replace ? 1 : 0; // NULL RootDirectory + simple name stays in the same directory.
				data.writeUInt32LE(encoded.length, 16);
				encoded.copy(data, 20);
				const status = setInformation(handle, Buffer.alloc(16), data, data.length, 10);
				if (status < 0) throw failure(`Could not atomically replace the file (Windows status 0x${(status >>> 0).toString(16)}).`, status, true);
			} finally { close(handle); }
		},
		close,
	};
}
