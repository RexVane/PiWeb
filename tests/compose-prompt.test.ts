import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { composePrompt } from "@/lib/chat/compose-prompt";

describe("skill invocation with attachment references", () => {
	it.each(["@README.md", "Attached file: /uploads/note.txt (4 B)"])("expands the actual SDK skill command with %s and no prose arguments", async (addition) => {
		const { AgentSession } = await import("@earendil-works/pi-coding-agent");
		const expand = (AgentSession.prototype as unknown as { _expandSkillCommand(text: string): string })._expandSkillCommand;
		const location = path.resolve("README.md");
		const input = composePrompt("/skill:probe", [addition]);
		const expanded = expand.call({ resourceLoader: { getSkills: () => ({ skills: [{ name: "probe", filePath: location, baseDir: path.dirname(location) }] }) } }, input);
		expect(expanded).toContain('<skill name="probe"');
		expect(expanded).toContain(fs.readFileSync(location, "utf8").trim());
		expect(expanded.endsWith(`</skill>\n\n${addition}`)).toBe(true);
	});

	it("retains ordinary paragraphs and existing skill arguments", () => {
		expect(composePrompt("ordinary prompt", ["@README.md", "file"]).toString()).toBe("ordinary prompt\n\n@README.md\n\nfile");
		expect(composePrompt("/skill:probe explain this", ["@README.md"])).toBe("/skill:probe explain this\n\n@README.md");
		expect(composePrompt("/skill:probe", [])).toBe("/skill:probe");
	});
});
