import { describe, expect, it } from "vitest";
import { parseSkillBlock } from "@earendil-works/pi-coding-agent";
import { parseSkillMessage } from "../src/lib/skill-message";

const block = '<skill name="probe" location="/old/workspace/skills/probe/SKILL.md">\nReferences are relative to /old/workspace/skills/probe.\n\n# Probe\n\nHistorical instructions.\n</skill>';

describe("skill message presentation", () => {
	it.each([block, `${block}\n\nUser question\nsecond line`])("matches the SDK envelope without altering its content", (text) => {
		const sdk = parseSkillBlock(text)!;
		expect(parseSkillMessage(text)).toEqual({ ...sdk, userMessage: sdk.userMessage ?? "" });
	});
	it("also recognizes CRLF envelopes", () => {
		expect(parseSkillMessage(`${block}\n\nQuestion`.replaceAll("\n", "\r\n"))?.userMessage).toBe("Question");
	});
	it.each(["ordinary text", `Example:\n${block}`, `\`\`\`xml\n${block}\n\`\`\``, block.replace("</skill>", ""), `${block}\nnot an SDK separator`])("leaves ordinary and incomplete text untouched", (text) => {
		expect(parseSkillMessage(text)).toBeNull();
	});
});
