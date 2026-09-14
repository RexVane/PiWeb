import fs from "node:fs";
import { fileURLToPath } from "node:url";

/** Identify direct Node execution without importing launcher/browser code. */
export function isMainModule(url) {
	if (!process.argv[1]) return false;
	try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(url)); } catch { return false; }
}
