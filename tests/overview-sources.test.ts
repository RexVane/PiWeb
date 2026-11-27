import { expect, it } from "vitest";
import { overviewSources } from "@/lib/overview-sources";
import type { WebMessage } from "@/lib/types";

it("lists draft attachments, localized sent attachments and web citations once, keeping URLs from shell output private", () => {
	const path = "/agent/web-uploads/2026-11-27T08-00-00-000Z_release notes.md";
	const messages: WebMessage[] = [
		{ role: "user", id: "u1", content: [
			{ type: "text", text: "附件：" + path + "（4KB）\n@src/main.ts\n[Docs](https://docs.example.com/guide)" },
			{ type: "image", mimeType: "image/png", data: "eA==" },
		] },
		{ role: "assistant", id: "a1", content: [{ type: "text", text: "https://docs.example.com/guide" }] },
	];
	const draft = { text: "", images: [], references: ["src/main.ts"], uploads: [{ path, name: "release notes.md", size: 4096 }] };
	const tools = {
		search: { name: "web_search", args: { query: "PiWeb" }, state: "done" as const, result: '{"results":[{"url":"https://example.com/article","title":"Article"}]}' },
		shell: { name: "bash", args: { command: "test" }, state: "done" as const, result: "https://example.com/internal" },
	};
	const { sources, searches, opened } = overviewSources(draft, messages, tools);
	expect([searches, opened]).toEqual([1, 0]);
	expect(sources.filter((s) => s.kind === "file" || s.kind === "upload")).toHaveLength(2);
	expect(sources.filter((s) => s.kind === "link").map((s) => s.url)).toEqual(["https://docs.example.com/guide", "https://example.com/article"]);
	expect(sources.some((s) => s.kind === "image")).toBe(true);
	expect(overviewSources({ text: "", images: [], uploads: [] }, messages, {}).sources).toContainEqual({ kind: "upload", path, label: "release notes.md", origins: ["attached"] });
});

it("counts confirmed searches and distinct opened URLs, retaining both provided and read evidence", () => {
	const url = "https://example.com/a";
	const draft = { text: "", images: [], uploads: [] };
	const messages: WebMessage[] = [{ role: "user", content: [{ type: "text", text: url }] }];
	const fetchTool = { name: "web_fetch", state: "done" as const, args: { url }, result: "Page text" };
	const { sources, searches, opened } = overviewSources(draft, messages, {
		first: fetchTool, second: { ...fetchTool }, failed: { ...fetchTool, isError: true, args: { url: "https://example.com/b" } },
		pending: { name: "web_search", args: { query: "x" }, state: "running", partialResult: url },
		noResult: { name: "web_fetch", args: { url: "https://example.com/c" }, state: "done" },
		nested: { name: "web_search", args: { query: "Pi" }, state: "done", recordedStatus: "ok" },
		unfinished: { name: "web_fetch", args: { url: "https://example.com/d" }, state: "done", recordedStatus: "unfinished" },
	});
	expect({ searches, opened }).toEqual({ searches: 1, opened: 1 });
	expect(sources).toEqual([{ kind: "link", url, label: "example.com/a", origins: ["provided", "read"] }]);
});
