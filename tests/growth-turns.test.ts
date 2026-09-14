import { describe, expect, it } from "vitest";
import { userTurnsFromEntries } from "../src/lib/growth-turns";

describe("userTurnsFromEntries", () => {
	it("keeps every persisted user round, including entries omitted from rendered context", () => {
		const entries = [
			{ type: "message", id: "a", timestamp: "2026-09-12T01:00:00.000Z", message: { role: "user", timestamp: 1 } },
			{ type: "compaction", id: "compact", timestamp: "2026-09-12T01:01:00.000Z" },
			{ type: "message", id: "b", timestamp: "2026-09-12T01:02:00.000Z", message: { role: "user", timestamp: 2 } },
			{ type: "message", id: "reply", timestamp: "2026-09-12T01:03:00.000Z", message: { role: "assistant" } },
		];
		expect(userTurnsFromEntries(entries)).toEqual([
			{ id: "a", ts: Date.parse("2026-09-12T01:00:00.000Z") },
			{ id: "b", ts: Date.parse("2026-09-12T01:02:00.000Z") },
		]);
	});
});
