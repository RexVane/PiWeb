import fs from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

const SHARING_ERRORS = new Set(["EPERM", "EACCES", "EBUSY"]);

/** Readers or antivirus can briefly block replacement on Windows. Keep the old file intact while retrying. */
export async function replaceFileAtomically(source: string, destination: string, beforeReplace?: () => Promise<void>): Promise<void> {
	for (let attempt = 0; ; attempt += 1) {
		// A sharing violation may outlive the original version check. Revalidate
		// after every delay so a concurrent edit is not overwritten by a retry.
		await beforeReplace?.();
		try {
			await fs.rename(source, destination);
			return;
		} catch (error) {
			if (attempt >= 9 || !SHARING_ERRORS.has((error as NodeJS.ErrnoException).code ?? "")) throw error;
			await delay(Math.min(25 * (attempt + 1), 100));
		}
	}
}
