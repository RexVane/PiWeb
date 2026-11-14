const KEY = "piweb.currentSession";
export function savedSessionLocation(allowStoredFallback = true): string | null {
	try {
		const id = new URL(window.location.href).searchParams.get("session");
		if (id) {
			if (!/^[a-z\d_-]+$/i.test(id) || id.length > 16_384) return null;
			const binary = atob(id.replace(/-/g, "+").replace(/_/g, "/"));
			return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
		}
		return allowStoredFallback ? sessionStorage.getItem(KEY) : null;
	} catch { return null; }
}

export function storeSessionLocation(path: string | null, push = true): void {
	try { if (path) sessionStorage.setItem(KEY, path); else sessionStorage.removeItem(KEY); } catch { /* URL still carries the session */ }
	const url = new URL(window.location.href);
	if (path) {
		const binary = Array.from(new TextEncoder().encode(path), (byte) => String.fromCharCode(byte)).join("");
		url.searchParams.set("session", btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""));
	} else url.searchParams.delete("session");
	if (url.href !== window.location.href) {
		try { if (push) window.history.pushState(null, "", url); else window.history.replaceState(null, "", url); } catch { /* restricted history */ }
	}
}
