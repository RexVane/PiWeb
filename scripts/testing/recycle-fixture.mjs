import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

/** Recycle only files created by a verification run; unavailable Trash retains them. */
export function recycleGeneratedFixtureSync(location) {
	const absolute = path.resolve(location);
	if (!fs.existsSync(absolute)) return true;
	const temporary = fs.realpathSync(os.tmpdir());
	const target = path.join(fs.realpathSync(path.dirname(absolute)), path.basename(absolute));
	const relative = path.relative(temporary, target);
	if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Verification cleanup escaped the temporary directory.");
	let result;
	if (process.platform === "win32") {
		const script = fileURLToPath(new URL("../recycle-item.ps1", import.meta.url));
		result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", script, "-LiteralPath", target], { windowsHide: true, encoding: "utf8", timeout: 30_000 });
	} else if (process.platform === "darwin") {
		result = spawnSync("/usr/bin/osascript", ["-e", "on run argv", "-e", 'tell application "Finder" to delete (POSIX file (item 1 of argv) as alias)', "-e", "end run", target], { encoding: "utf8", timeout: 30_000 });
	} else {
		result = spawnSync("gio", ["trash", "--", target], { encoding: "utf8", timeout: 30_000 });
	}
	return !result.error && result.status === 0 && !fs.existsSync(target);
}
