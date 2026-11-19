/** Browser-only lexical normalization for viewer tabs; the server still checks realpath/junctions. */
export function workspaceTabPath(raw: string, cwd?: string): string | null {
	const normalize = (value: string) => {
		const parts: string[] = [];
		for (const part of value.replace(/\\/g, "/").split("/")) {
			if (!part || part === ".") continue;
			if (part === "..") {
				if (!parts.length) return null;
				parts.pop();
			} else parts.push(part);
		}
		return parts.join("/");
	};
	let value = raw.trim().replace(/\\/g, "/");
	if (!value || /[\u0000-\u001f\u007f]/.test(value)) return null;
	const rootRaw = cwd?.replace(/\\/g, "/");
	const windows = !!rootRaw && (/^[A-Za-z]:\//.test(rootRaw) || rootRaw.startsWith("//"));
	// Terminal tools can return MSYS paths while the session cwd is a Windows path.
	if (windows) value = value.replace(/^\/([A-Za-z])\//, (_, drive: string) => `${drive}:/`);
	const absolute = /^[A-Za-z]:/.test(value) || value.startsWith("/");
	if (!absolute) {
		const relative = normalize(value);
		return relative === null ? null : relative || ".";
	}
	if (!rootRaw || /^[A-Za-z]:(?!\/)/.test(value)) return null;
	// A rooted Windows path without drive is ambiguous; do not invent a drive.
	if (windows && value.startsWith("/") && !value.startsWith("//")) return null;
	if (!windows && /^[A-Za-z]:/.test(value)) return null;
	const root = normalize(rootRaw);
	const path = normalize(value);
	if (root === null || path === null) return null;
	if (!windows && root === "") return path || ".";
	const comparable = (text: string) => windows ? text.toLowerCase() : text;
	if (comparable(path) === comparable(root)) return ".";
	if (!comparable(path).startsWith(`${comparable(root)}/`)) return null;
	return path.slice(root.length + 1);
}
