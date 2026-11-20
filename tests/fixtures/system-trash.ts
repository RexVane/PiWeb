import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isPathInside, samePath } from "../../src/lib/path-boundary";
import { moveToTrash } from "../../src/lib/recycle-bin";

/** Only fixtures created by this test run; never permanently delete on headless runners. */
export async function recycleGeneratedFixture(directory: string): Promise<void> {
	const absolute = path.resolve(directory);
	const stat = await fs.lstat(absolute).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return undefined;
		throw error;
	});
	if (!stat) return;
	const temporary = await fs.realpath(os.tmpdir());
	const target = path.join(await fs.realpath(path.dirname(absolute)), path.basename(absolute));
	if (!isPathInside(temporary, target) || samePath(temporary, target)) throw new Error("Fixture cleanup escaped the temporary directory.");
	try {
		if (process.platform === "darwin" && stat.isDirectory() && !stat.isSymbolicLink()) {
			await promisify(execFile)("/usr/bin/osascript", ["-e", "on run argv", "-e", 'tell application "Finder" to delete (POSIX file (item 1 of argv) as alias)', "-e", "end run", target], { timeout: 30_000 });
		} else await moveToTrash(target, { managedRoot: path.dirname(target), expectedLink: stat.isSymbolicLink() });
	} catch { /* A headless runner without system Trash retains its generated fixture. */ }
}
