import type { ChatDraft } from "@/components/ChatInput";
import type { ToolCardState } from "@/hooks/usePiWeb";
import type { WebContent, WebMessage } from "./types";
import { classifyWebTool, extractWebSources, formatWebUrlLabel, type WebSource } from "./web-search";

type SourceImage = Extract<WebContent, { type: "image" }>;
export type SourceOrigin = "draft" | "attached" | "provided" | "mentioned" | "found" | "read";
type SourceItem =
	| { kind: "file" | "upload"; path: string; label: string }
	| { kind: "link"; url: string; label: string }
	| { kind: "image"; id: string; image: SourceImage };

export type OverviewSource = SourceItem & { origins: SourceOrigin[] };

function fileName(path: string): string {
	return path.split(/[/\\]/).pop() || path;
}

function links(sources: WebSource[], origin: SourceOrigin): OverviewSource[] {
	return sources.map(({ url, title }) => ({ kind: "link", url, label: title || formatWebUrlLabel(url), origins: [origin] }));
}

function textSources(text: string, origin: "draft" | "provided" | "mentioned"): OverviewSource[] {
	const sources: OverviewSource[] = [];
	if (origin !== "mentioned") {
		for (const line of text.split(/\r?\n/)) {
			// File chips in a sent prompt use these wire formats in all five UI languages.
			const upload = /^(?:附件|添付|Attachment|Вложение)\s*[:：]\s*(.+[/\\]web-uploads[/\\][^/\\]+?)\s*[（(][\d.,]+\s*[A-Za-z]+[）)]\s*$/i.exec(line);
			if (upload) {
				const path = upload[1].trim();
				const label = fileName(path).replace(/^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z_/, "");
				sources.push({ kind: "upload", path, label, origins: [origin === "draft" ? "draft" : "attached"] });
			} else if (line.startsWith("@") && line.slice(1).trim()) {
				const path = line.slice(1).trim();
				sources.push({ kind: "file", path, label: fileName(path), origins: [origin] });
			}
		}
	}
	if (/https?:\/\//i.test(text)) sources.push(...links(extractWebSources(undefined, text), origin));
	return sources;
}

// Completed messages and tool states keep their identity during streaming. Do not reparse past turns on every delta.
const messageCache = new WeakMap<WebMessage, OverviewSource[]>();
type WebActivity = { sources: OverviewSource[]; searches: number; opened: string[] };
const toolCache = new WeakMap<ToolCardState, WebActivity>();

function messageSources(message: WebMessage): OverviewSource[] {
	const cached = messageCache.get(message);
	if (cached) return cached;
	const sources: OverviewSource[] = [];
	for (const [index, part] of message.content.entries()) {
		if (message.role === "user" && part.type === "image") {
			sources.push({ kind: "image", id: [message.id ?? message.streamId ?? message.timestamp, index].join(":"), image: part, origins: ["attached"] });
		} else if (part.type === "text") {
			sources.push(...textSources(part.text, message.role === "user" ? "provided" : "mentioned"));
		}
	}
	messageCache.set(message, sources);
	return sources;
}

function toolSources(tool: ToolCardState): WebActivity {
	const cached = toolCache.get(tool);
	if (cached) return cached;
	const activity: WebActivity = { sources: [], searches: 0, opened: [] };
	// A restored tool call without a result, or a failed fetch, does not prove a page was read.
	const completed = tool.recordedStatus ? tool.recordedStatus === "ok" : tool.result !== undefined || tool.endedAt !== undefined;
	if (tool.state === "done" && !tool.isError && completed) {
		const role = classifyWebTool(tool.name, tool.args, tool.result);
		if (role) {
			if (role === "fetch") {
				const targets = extractWebSources(tool.args, undefined, role);
				activity.opened = targets.map((target) => target.url);
				activity.sources.push(...links(targets, "read"));
			} else {
				activity.searches = 1;
			}
			const discovered = extractWebSources(undefined, tool.result).filter((source) => !activity.opened.includes(source.url));
			activity.sources.push(...links(discovered, role === "search" ? "found" : "mentioned"));
		}
	}
	toolCache.set(tool, activity);
	return activity;
}

export function overviewSourceKey(source: OverviewSource): string {
	if (source.kind === "link") return source.url;
	if (source.kind === "image") return "image:" + source.id;
	return source.kind + ":" + source.path;
}

export function overviewSources(draft: ChatDraft, messages: readonly WebMessage[], tools: Record<string, ToolCardState>) {
	const collected = new Map<string, OverviewSource>();
	const add = (source: OverviewSource) => {
		const key = overviewSourceKey(source);
		const existing = collected.get(key);
		if (!existing) {
			collected.set(key, { ...source, origins: [...source.origins] });
		} else {
			for (const origin of source.origins) if (!existing.origins.includes(origin)) existing.origins.push(origin);
		}
	};
	for (const { name, path } of draft.uploads) add({ kind: "upload", path, label: name, origins: ["draft"] });
	for (const [index, image] of draft.images.entries()) add({ kind: "image", id: "draft:" + index, image, origins: ["draft"] });
	for (const path of draft.references ?? []) add({ kind: "file", path, label: fileName(path), origins: ["draft"] });
	textSources(draft.text, "draft").forEach(add);
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role === "user" || message.role === "assistant") messageSources(message).forEach(add);
	}
	const opened = new Set<string>();
	let searches = 0;
	for (const tool of Object.values(tools).reverse()) {
		const activity = toolSources(tool);
		searches += activity.searches;
		activity.opened.forEach((url) => opened.add(url));
		activity.sources.forEach(add);
	}
	return { sources: [...collected.values()], searches, opened: opened.size };
}
