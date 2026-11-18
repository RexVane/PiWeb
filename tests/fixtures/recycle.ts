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

/** Best-effort cleanup of a test-owned fixture directory. */
export async function recycleFixture(directory: string): Promise<void> {
	const absolute = path.resolve(directory);
	// Compare canonical spellings: Windows temp dirs can be given as 8.3 short names
	// (`C:\Users\RUNNER~1\...`) while realpaths and `os.tmpdir()` disagree on spelling.
	if (!comparablePath(absolute).startsWith(comparablePath(os.tmpdir()) + path.sep)) throw new Error("Fixture cleanup escaped the system temporary directory.");
	if (process.platform !== "win32") {
		await fs.promises.rm(absolute, { recursive: true, force: true, maxRetries: 3 });
		return;
	}
	try {
		await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", recycleScript(absolute)], { windowsHide: true });
		return;
	} catch {
		// Hosted runners have no Recycle Bin, and ACL/git fixtures contain read-only or
		// hidden entries. Purge attributes, then delete recursively; cleanup is best-effort
		// so a locked fixture never turns into a test failure.
		try {
			await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
				"$target = '" + absolute.replaceAll("'", "''") + "'\n" +
				"if (-not [System.IO.Directory]::Exists($target)) { exit 0 }\n" +
				"Get-ChildItem -LiteralPath $target -Recurse -Force | ForEach-Object { try { $_.Attributes = 'Normal' } catch {} }\n",
			], { windowsHide: true });
		} catch { /* best effort */ }
		try {
			await fs.promises.rm(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		} catch (error) {
			console.warn("[test] could not remove fixture " + absolute + ": " + (error instanceof Error ? error.message : String(error)));
		}
	}
}
