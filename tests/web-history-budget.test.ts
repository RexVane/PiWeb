import { describe, expect, it } from "vitest";
import * as sdk from "@earendil-works/pi-coding-agent";
import { historyPage, previewMessage, recentMessages, recentTrajectory } from "../src/lib/chat/web-history";
import type { WebMessage } from "../src/lib/types";

const message = (index: number, text = `message ${index}`): WebMessage => ({ id: String(index), role: "user", content: [{ type: "text", text }] });

describe("bounded web history", () => {
	it("can traverse every record in both directions without growing a page", () => {
		const all = Array.from({ length: 803 }, (_, index) => message(index));
		const seen: string[] = []; let before: number | undefined;
		do {
			const page = historyPage(all, { before, limit: 100 });
			expect(page.messages.length).toBeLessThanOrEqual(100);
			seen.unshift(...page.messages.map((item) => item.id!)); before = page.olderBefore;
		} while (before !== undefined);
		expect(seen).toEqual(all.map((item) => item.id));
		expect(historyPage(all, { after: 100, limit: 100 })).toMatchObject({ pageStart: 100, pageEnd: 200, newerAfter: 200 });
	});
	it("uses byte budgets with no cursor gaps for large CJK messages", () => {
		const all = Array.from({ length: 150 }, (_, index) => message(index, "中".repeat(100_000)));
		const last = historyPage(all, { limit: 100 });
		expect(Buffer.byteLength(JSON.stringify(last))).toBeLessThan(5 * 1024 * 1024 + 10_000);
		expect(last.messages.at(-1)?.id).toBe("149");
		const older = historyPage(all, { before: last.olderBefore, limit: 100 });
		expect(Number(older.messages.at(-1)?.id) + 1).toBe(Number(last.messages[0].id));
	});
	it("does not serialize stored image bodies when their authenticated URL is available", () => {
		const original: WebMessage = { role: "user", content: [{ type: "image", data: "a".repeat(8_000_000), mimeType: "image/png" }] };
		expect(previewMessage(original, (part) => `/api/image?part=${part}`).content).toEqual([{ type: "image", data: "", mimeType: "image/png", url: "/api/image?part=0" }]);
		expect(original.content[0]).toHaveProperty("data", "a".repeat(8_000_000));
	});
	it("bounds oversized display content and keeps the source unchanged", () => {
		const original = message(1, "x".repeat(2_000_000));
		expect(previewMessage(original)).toMatchObject({ truncated: true });
		expect(JSON.stringify(previewMessage(original)).length).toBeLessThan(101_000);
		expect(original.content[0]).toHaveProperty("text", "x".repeat(2_000_000));
		expect(recentMessages(Array.from({ length: 1000 }, (_, index) => message(index))).length).toBe(300);
		expect(recentTrajectory(Array.from({ length: 1500 }, (_, seq) => ({ seq, kind: "tool", ts: seq }))).length).toBe(1000);
	});
	it("shares the byte budget across all nested tool results", () => {
		const nestedCalls = Array.from({ length: 100 }, (_, index) => ({ id: String(index), name: "tool", status: "ok" as const, args: { text: "x".repeat(8000) } }));
		const huge: WebMessage = { role: "toolResult", content: Array.from({ length: 100 }, () => ({ type: "toolResult", text: "x".repeat(100_000), nestedCalls })) };
		const preview = previewMessage(huge);
		expect(preview.truncated).toBe(true);
		expect(Buffer.byteLength(JSON.stringify(preview))).toBeLessThan(600_000);
		expect(huge.content.length).toBe(100);
	});
	it("detects SDK builtin additions that need an explicit permission policy review", () => {
		const exportedDefinitions = Object.keys(sdk).filter((name) => /^create\w+ToolDefinition$/.test(name)).sort();
		expect(exportedDefinitions).toEqual(["Bash", "Edit", "Find", "Grep", "Ls", "PowerShell", "Read", "Write"].map((name) => `create${name}ToolDefinition`).sort());
	});
});
