/** Runs before the child entrypoint: a parent killed between spawn and tracking
 * cannot leave a service/build that starts after another owner acquired its lock.
 */
import { trackLockChild } from "./file-lock.mjs";
const file = process.env.PIWEB_PROCESS_LOCK_FILE ?? process.env.PIWEB_BUILD_LOCK_FILE;
const token = process.env.PIWEB_PROCESS_LOCK_TOKEN ?? process.env.PIWEB_BUILD_LOCK_TOKEN;
if (file || token) {
	if (!file || !token) throw new Error("Incomplete process lock handoff");
	trackLockChild(file, token, process.pid);
}
