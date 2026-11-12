/** Notify open session views after a server-confirmed import, deletion or archive change. */
export const SESSION_CHANGE_EVENT = "piweb:sessions-changed";

export function notifySessionsChanged(): void {
	if (typeof window !== "undefined") window.dispatchEvent(new Event(SESSION_CHANGE_EVENT));
}
