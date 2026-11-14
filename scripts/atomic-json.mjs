import fs from "node:fs";
import { randomUUID } from "node:crypto";
/** Durable complete-file publication; failed replacements retain the old bytes. */
export function writeJsonAtomically(file, value) {
	const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
	const handle = fs.openSync(temporary, "wx", 0o600);
	try { fs.writeFileSync(handle, `${JSON.stringify(value, null, 2)}\n`); fs.fsyncSync(handle); }
	finally { fs.closeSync(handle); }
	const deadline = Date.now() + 1_000;
	while (true) {
		try { fs.renameSync(temporary, file); return; }
		catch (error) {
			if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(error.code) || Date.now() >= deadline) throw error;
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
		}
	}
}
