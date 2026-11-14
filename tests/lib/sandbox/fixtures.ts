import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";

const run = promisify(execFile);
/** Test-owned fixtures are recycled; unrelated temporary files are never removed. */
export async function recycleFixture(directory: string): Promise<void> {
	const absolute = path.resolve(directory);
	if (!absolute.toLowerCase().startsWith(path.resolve(os.tmpdir()).toLowerCase() + path.sep)) throw new Error("Fixture cleanup escaped the system temporary directory.");
	if (process.platform !== "win32") return;
	const literal = absolute.replaceAll("'", "''");
	await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory('" + literal + "','OnlyErrorDialogs','SendToRecycleBin')"], { windowsHide: true });
}
export async function aclOf(target: string): Promise<string> {
	const module = await import("koffi");
	const koffi = module.default ?? module;
	const api = koffi.load("advapi32.dll");
	const localFree = koffi.load("kernel32.dll").func("void *LocalFree(void *memory)");
	const get = api.func("uint32 GetNamedSecurityInfoW(str16 name, uint32 type, uint32 info, void *owner, void *group, void *dacl, void *sacl, void *descriptor)");
	const stringify = api.func("bool ConvertSecurityDescriptorToStringSecurityDescriptorW(void *descriptor, uint32 revision, uint32 info, void *output, void *length)");
	const descriptor = Buffer.alloc(8), output = Buffer.alloc(8), length = Buffer.alloc(4);
	const pointer = (buffer: Buffer) => Number(buffer.readBigUInt64LE());
	const error = get(path.resolve(target), 1, 0x17, null, null, null, null, descriptor);
	if (error) throw new Error("GetNamedSecurityInfo failed: " + error);
	try {
		if (!stringify(pointer(descriptor), 1, 0x17, output, length)) throw new Error("Could not inspect fixture security.");
		return koffi.decode(pointer(output), "char16_t", -1) as string;
	} finally {
		if (pointer(output)) localFree(pointer(output));
		localFree(pointer(descriptor));
	}
}
