/**
 * /skill:name 展开的识别：pi 会把 SKILL.md 正文展开成一整段提示词（见 lib/chat/skill-expansion），
 * 用户打的正文接在 `</skill>` 之后，与技能正文同属一条用户消息。这里盯三件事：
 *   - 真的展开能认出来（名称、参数都对）；
 *   - 界面只显示技能名 + 参数，SKILL.md 正文不进界面；
 *   - 普通消息不会被误判——正文里恰好提到 <skill 字样、半截内容（没有闭合标签）都要放过。
 */
import { describe, expect, it } from "vitest";
import { parseExpandedSkill } from "@/lib/chat/skill-expansion";

const expanded = (name: string, body = "正文内容", base = "/Users/x/.agents/skills") =>
	`<skill name="${name}" location="${base}/${name}/SKILL.md">\nReferences are relative to ${base}/${name}.\n\n${body}\n</skill>`;

describe("parseExpandedSkill", () => {
	it(" recognises an expanded skill and returns its name", () => {
		expect(parseExpandedSkill(expanded("computer-use"))).toEqual({ name: "computer-use", args: "" });
	});

	it("keeps the arguments pi appends after the skill block", () => {
		// 有参数时展开结果形如 `<skill ...>…</skill>\n\n参数`；参数要显示（Claude Code 里它是技能调用的入参）
		const withArgs = `${expanded("pdf-tools")}\n\nextract report.pdf`;
		expect(parseExpandedSkill(withArgs)).toEqual({ name: "pdf-tools", args: "extract report.pdf" });
	});

	it("keeps multi-line arguments intact", () => {
		const withArgs = `${expanded("pdf-tools")}\n\n第一行\n第二行`;
		expect(parseExpandedSkill(withArgs)?.args).toBe("第一行\n第二行");
	});

	it("tolerates leading whitespace", () => {
		expect(parseExpandedSkill(`\n\n  ${expanded("pdf-tools")}`)).toEqual({ name: "pdf-tools", args: "" });
	});

	it("does not treat ordinary messages as skills", () => {
		expect(parseExpandedSkill("帮我看看 <skill name=\"x\"> 这个标签")).toBeNull();
		expect(parseExpandedSkill("普通提问")).toBeNull();
		expect(parseExpandedSkill("")).toBeNull();
	});

	it("requires a closing tag so a half-streamed block is not shown as a chip", () => {
		expect(parseExpandedSkill('<skill name="pdf-tools" location="/tmp/SKILL.md">\n正文还没写完')).toBeNull();
	});

	it("requires a name attribute", () => {
		expect(parseExpandedSkill('<skill location="/tmp/SKILL.md">\n正文\n</skill>')).toBeNull();
	});
});
