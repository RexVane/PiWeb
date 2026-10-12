import fs from "node:fs/promises";
import path from "node:path";
import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui/dist/autocomplete.js";
import { getAgentDir } from "./pi";
import { BoundaryError, resolveWorkspacePath } from "./path-security";
import type { FileCompletions } from "./file-completion";

/** Reuse the fd installed by pi CLI, then try the system PATH (including Debian's fdfind). */
async function findFd(): Promise<string | null> {
	const names = process.platform === "win32" ? ["fd.exe", "fdfind.exe"] : ["fd", "fdfind"];
	const dirs = [path.join(getAgentDir(), "bin"), ...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean)];
	for (const dir of dirs) {
		for (const name of names) {
			const candidate = path.join(dir, name);
			try {
				await fs.access(candidate, fs.constants.X_OK);
				if ((await fs.stat(candidate)).isFile()) return candidate;
			} catch { /* Try the next installed binary. */ }
		}
	}
	return null;
}

export async function completeFiles(cwd: unknown, text: unknown, cursor: unknown, signal: AbortSignal): Promise<FileCompletions> {
	if (typeof text !== "string" || text.length > 64 * 1024 || !Number.isInteger(cursor) || (cursor as number) < 0 || (cursor as number) > text.length) {
		throw new BoundaryError("invalid file completion input");
	}
	const root = await resolveWorkspacePath(cwd);
	const fd = await findFd();
	if (!fd) throw new BoundaryError("File search requires fd. Run pi once to install its file search tool.");
	const provider = new CombinedAutocompleteProvider([], root, fd);
	const lines = text.split("\n");
	const before = text.slice(0, cursor as number).split("\n");
	const line = before.length - 1;
	const col = before[line].length;
	const suggestions = await provider.getSuggestions(lines, line, col, { signal });
	// This endpoint exposes @ completion only; slash commands remain handled by the UI.
	if (!suggestions?.prefix.startsWith("@")) return { prefix: "", items: [] };
	return {
		prefix: suggestions.prefix,
		items: suggestions.items.map((item) => {
			const completed = provider.applyCompletion(lines, line, col, item, suggestions.prefix);
			return {
				...item,
				text: completed.lines.join("\n"),
				cursor: completed.lines.slice(0, completed.cursorLine).reduce((offset, value) => offset + value.length + 1, 0) + completed.cursorCol,
			};
		}),
	};
}
