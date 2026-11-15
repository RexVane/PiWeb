import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";

const run = promisify(execFile);
/**
 * Expand Windows 8.3 short names and links without requiring the whole path to exist.
 * `fs.realpath` fails on a directory a fixture already removed, so walk up to the
 * nearest existing ancestor and keep the remaining components as written.
 */
function canonicalPath(value: string): string {
	const resolved = path.resolve(value);
	const suffix: string[] = [];
	let current = resolved;
	for (;;) {
		try {
			const real = fs.realpathSync.native(current);
			return suffix.length ? path.join(real, ...suffix.reverse()) : real;
		} catch {
			const parent = path.dirname(current);
			if (parent === current) return resolved;
			suffix.push(path.basename(current));
			current = parent;
		}
	}
}

function comparablePath(value: string): string {
	const canonical = canonicalPath(value);
	return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

// Hosted Windows runners/containers have no shell Recycle Bin, so the .NET recycle
// API throws "This function is not supported on this system". The path was already
// proven to be a test-owned directory under the system temp root above, so fall back
// to a permanent recursive delete there; developer machines keep recycling.
const recycleScript = (target: string) => [
	"$target = '" + target.replaceAll("'", "''") + "'",
	"if (-not [System.IO.Directory]::Exists($target)) { exit 0 }",
	"try {",
	"  Add-Type -AssemblyName Microsoft.VisualBasic",
	"  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($target,'OnlyErrorDialogs','SendToRecycleBin')",
	"} catch {",
	"  if ($_.Exception.ToString() -match 'not supported|NotSupported') { [System.IO.Directory]::Delete($target, $true) } else { throw }",
	"}",
].join("\n");

/** Test-owned fixtures are recycled; unrelated temporary files are never removed. */
export async function recycleFixture(directory: string): Promise<void> {
	const absolute = path.resolve(directory);
	// Compare canonical spellings: Windows temp dirs can be given as 8.3 short names
	// (`C:\Users\RUNNER~1\...`) while realpaths and `os.tmpdir()` disagree on spelling.
	if (!comparablePath(absolute).startsWith(comparablePath(os.tmpdir()) + path.sep)) throw new Error("Fixture cleanup escaped the system temporary directory.");
	if (process.platform !== "win32") return;
	await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", recycleScript(absolute)], { windowsHide: true });
}
/**
 * Windows 8.3 spelling of an existing path (e.g. the CI temp dir `C:\Users\RUNNER~1\...`).
 * Returns the input path unchanged when the volume has 8.3 alias generation disabled.
 */
export async function shortPathOf(target: string): Promise<string> {
	const module = await import("koffi");
	const koffi = module.default ?? module;
	const getShortPathName = koffi.load("kernel32.dll").func("uint32 GetShortPathNameW(str16 longPath, void *shortPath, uint32 bufferLength)");
	const buffer = Buffer.alloc(64 * 1024);
	const length = getShortPathName(path.resolve(target), buffer, buffer.length / 2);
	if (!length) throw new Error("GetShortPathNameW failed");
	return koffi.decode(buffer, "char16_t", -1) as string;
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
