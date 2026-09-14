import { describe, expect, it } from "vitest";
import { diffStats, parseUnifiedDiff } from "../src/components/DiffView";

describe("parseUnifiedDiff", () => {
	it("does not mistake SQL/Lua comment removals or additions for file headers", () => {
		const parsed = parseUnifiedDiff("--- a/test.sql\n+++ b/test.sql\n@@ -1,2 +1,2 @@\n--- old comment\n+++ new comment\n SELECT 1;\n");
		expect(parsed).toEqual([
			{ kind: "file", text: "test.sql" },
			{ kind: "del", old: 1, text: "-- old comment" },
			{ kind: "add", new: 1, text: "++ new comment" },
			{ kind: "ctx", old: 2, new: 2, text: "SELECT 1;" },
		]);
		expect(diffStats(parsed!)).toEqual({ add: 1, del: 1 });
	});
	it("parses multi-file patches and zero-side hunks including deleted file names", () => {
		const parsed = parseUnifiedDiff([
			"diff --git a/new.lua b/new.lua", "new file mode 100644", "--- /dev/null", "+++ b/new.lua",
			"@@ -0,0 +1,2 @@", "+-- comment", "+return true", "\\ No newline at end of file",
			"diff --git a/old.sql b/old.sql", "deleted file mode 100644", "--- a/old.sql", "+++ /dev/null",
			"@@ -1,2 +0,0 @@", "--- comment", "-SELECT 1;", "\\ No newline at end of file", "",
		].join("\n"));
		expect(parsed?.filter((line) => line.kind === "file").map((line) => line.text)).toEqual(["new.lua", "old.sql"]);
		expect(diffStats(parsed!)).toEqual({ add: 2, del: 2 });
		expect(parsed?.at(-1)).toEqual({ kind: "del", old: 2, text: "SELECT 1;" });
	});
	it("handles omitted counts, later hunks, blank context and no-newline markers", () => {
		expect(parseUnifiedDiff("@@ -3 +7 @@\n-a\n\\ No newline at end of file\n+b\n\\ No newline at end of file\n@@ -10,2 +14,2 @@ context\n \n-last\n+next\n")).toEqual([
			{ kind: "del", old: 3, text: "a" }, { kind: "add", new: 7, text: "b" }, { kind: "hunk", text: "…" },
			{ kind: "ctx", old: 10, new: 14, text: "" }, { kind: "del", old: 11, text: "last" }, { kind: "add", new: 15, text: "next" },
		]);
	});
	it("recognizes paired headers with timestamps/quoted paths and CRLF", () => {
		const parsed = parseUnifiedDiff('--- "a/a b.ts"\t2026-01-01\r\n+++ "b/a b.ts"\t2026-01-02\r\n@@ -0,0 +1 @@\r\n+ok\r\n--- a/next\n+++ b/next\n@@ -1 +0,0 @@\n-old');
		expect(parsed?.filter((line) => line.kind === "file").map((line) => line.text)).toEqual(["a b.ts", "next"]);
	});
	it("does not invent lines from zero-sized hunks, metadata, or trailing whitespace", () => {
		expect(parseUnifiedDiff("@@ -0,0 +0,0 @@\n")).toBeNull();
		expect(parseUnifiedDiff("not a patch\n+++ only a heading\n")).toBeNull();
		expect(parseUnifiedDiff("@@ -1 +1 @@\n-old\n+new\nindex metadata\nnot context\n")).toHaveLength(2);
	});
});
