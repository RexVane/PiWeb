import { describe, expect, it } from "vitest";
import { slashCommandToken } from "../src/lib/slash-command-token";

describe("slash commands at the caret", () => {
	it.each(["/", " /", "existing text /", "existing text\n/", "text\t/"])("recognizes %j", (text) => {
		expect(slashCommandToken(text, text.length)).toEqual({ start: text.length - 1, tokenEnd: text.length, query: "" });
	});
	it("replaces only the token while preserving text on both sides", () => {
		const text = "before /skill:probe after";
		expect(slashCommandToken(text, 10)).toEqual({ start: 7, tokenEnd: 19, query: "sk" });
	});
	it.each(["https://example.com/fast", "src/fast", "/home/user", "text /home/user", "text /fast argument"])("does not offer commands for %j", (text) => {
		expect(slashCommandToken(text, text.length)).toBeNull();
	});
	it("hides completion for selections and invalid carets", () => {
		for (const caret of [null, -1, 8]) expect(slashCommandToken("/fast", caret)).toBeNull();
	});
});
