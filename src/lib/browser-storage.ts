/** Preferences and drafts remain usable when browser storage is blocked or full. */
const memory = new Map<string, string>();
export const safeLocalStorage: Storage = {
	get length() { try { return localStorage.length; } catch { return memory.size; } },
	clear() { memory.clear(); try { localStorage.clear(); } catch { /* blocked */ } },
	getItem(key) { try { return localStorage.getItem(key); } catch { return memory.get(key) ?? null; } },
	key(index) { try { return localStorage.key(index); } catch { return [...memory.keys()][index] ?? null; } },
	removeItem(key) { memory.delete(key); try { localStorage.removeItem(key); } catch { /* blocked */ } },
	setItem(key, value) { try { localStorage.setItem(key, value); memory.delete(key); } catch { memory.set(key, value); } },
};
