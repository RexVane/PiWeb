/**
 * /skill:name 展开的识别：pi 会把 SKILL.md 正文展开成一整段提示词（见 lib/chat/skill-expansion），
 * 界面只显示技能名。这里盯两件事：
 *   - 真的展开能认出来（名称正确、参数与正文都不进界面）；
 *   - 普通消息不会被误判——正文里恰好提到 <skill 字样、半截内容（没有闭合标签）都要放过。
 */
import { describe, expect, it } from "vitest";
import { parseExpandedSkill } from "@/lib/chat/skill-expansion";

const expanded = (name: string, body = "正文内容", base = "/Users/x/.agents/skills") =>
	`<skill name="${name}" location="${base}/${name}/SKILL.md">\nReferences are relative to ${base}/${name}.\n\n${body}\n</skill>`;

describe("parseExpandedSkill", () => {
	it(" recognises an expanded skill and returns its name", () => {
		expect(parseExpandedSkill(expanded("computer-use"))).toEqual({ name: "computer-use" });
	});

	it("ignores the arguments that pi appends after the skill block", () => {
		// 有参数时展开结果形如 `<skill ...>…</skill>\n\n参数`，参数同样不显示
		const withArgs = `${expanded("pdf-tools")}\n\nextract report.pdf`;
		expect(parseExpandedSkill(withArgs)).toEqual({ name: "pdf-tools" });
	});

	it("tolerates leading whitespace", () => {
		expect(parseExpandedSkill(`\n\n  ${expanded("pdf-tools")}`)).toEqual({ name: "pdf-tools" });
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
