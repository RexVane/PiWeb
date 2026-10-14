import type { FileEntry } from "@earendil-works/pi-coding-agent";
import { BoundaryError } from "../path-security";
import { SIDE_CHAT_ENTRIES_LIMIT } from "./types";

const TYPES = new Set(["session", "message", "model_change", "thinking_level_change", "compaction", "branch_summary", "custom", "custom_message", "session_info", "label", "context_edit", "usage"]);
/** A browser may restore only the side conversation's memory tree; filesystem paths come from its owning main session. */
export function parseSideChatEntries(value: unknown): FileEntry[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.length > 20_000 || Buffer.byteLength(JSON.stringify(value), "utf8") > SIDE_CHAT_ENTRIES_LIMIT) throw new BoundaryError("side-chat history is too large to restore");
	const ids = new Set<string>();
	for (const entry of value) {
		if (!entry || typeof entry !== "object" || !TYPES.has(entry.type) || typeof entry.timestamp !== "string") throw new BoundaryError("invalid side-chat session history");
		if (entry.type === "session") continue;
		if (typeof entry.id !== "string" || ids.has(entry.id) || (entry.parentId !== null && !ids.has(entry.parentId))) throw new BoundaryError("invalid side-chat history tree");
		ids.add(entry.id);
		if (entry.type === "message" && (!entry.message || typeof entry.message.role !== "string")) throw new BoundaryError("invalid side-chat history message");
	}
	return value as FileEntry[];
}
