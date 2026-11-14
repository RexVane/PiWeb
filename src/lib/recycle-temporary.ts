import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

/** Only for temporary directories created by this operation; retain them if recycling fails. */
export async function recycleTemporaryDirectory(directory: string): Promise<void> {
	const resolved = path.resolve(directory);
	const relative = path.relative(path.resolve(os.tmpdir()), resolved);
	if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || !path.basename(resolved).startsWith("piweb-export-")) throw new Error("Unexpected temporary directory");
	if (process.platform === "win32") {
		const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory('${resolved.replace(/'/g, "''")}','OnlyErrorDialogs','SendToRecycleBin')`;
		await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true, timeout: 30_000 });
	} else {
		const trash = path.join(os.homedir(), ".local", "share", "Trash");
		const name = `${path.basename(resolved)}-${randomUUID()}`;
		await fs.mkdir(path.join(trash, "files"), { recursive: true });
		await fs.mkdir(path.join(trash, "info"), { recursive: true });
		await fs.writeFile(path.join(trash, "info", `${name}.trashinfo`), `[Trash Info]\nPath=${encodeURI(resolved)}\nDeletionDate=${new Date().toISOString().slice(0, 19)}\n`, { flag: "wx" });
		await fs.rename(resolved, path.join(trash, "files", name));
	}
}
