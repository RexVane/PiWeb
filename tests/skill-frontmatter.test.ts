import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { toggleSkillFrontmatterDisabled } from "@/lib/skill-frontmatter";

const frontmatter = (source: string) => parse(source.replace(/^\uFEFF/, "").split(/^---\s*$/m)[1]);

describe("skill YAML source preservation", () => {
	it("edits a quoted top-level key while preserving nested metadata and comments", () => {
		const source = '---\nname: fixture\ndescription: fixture\n"disable-model-invocation": false # preserve\nmetadata:\n  disable-model-invocation: false\n---\nbody';
		const next = toggleSkillFrontmatterDisabled(source, true);
		expect(next).toBe(source.replace('false # preserve', 'true # preserve'));
		expect(frontmatter(next)).toMatchObject({ "disable-model-invocation": true, metadata: { "disable-model-invocation": false } });
	});

	it("does not treat text inside a multiline description as a root field", () => {
		const source = '---\nname: fixture\ndescription: |\n  A description.\n  disable-model-invocation: false\n---\nbody';
		const next = toggleSkillFrontmatterDisabled(source, true);
		expect(frontmatter(next)).toMatchObject({ description: "A description.\ndisable-model-invocation: false\n", "disable-model-invocation": true });
	});

	it("preserves indentation of an indented root mapping", () => {
		const source = '---\n  name: fixture\n  description: fixture\n---\nbody';
		expect(frontmatter(toggleSkillFrontmatterDisabled(source, true))).toMatchObject({ name: "fixture", "disable-model-invocation": true });
	});

	it("adds the flag inside a flow-style root mapping", () => {
		const source = '---\n{name: fixture, description: fixture}\n---\nbody';
		expect(frontmatter(toggleSkillFrontmatterDisabled(source, true))).toMatchObject({ name: "fixture", "disable-model-invocation": true });
	});

	it("fills an empty root flag while preserving a valid mapping", () => {
		const source = '---\nname: fixture\ndescription: fixture\ndisable-model-invocation:\nmetadata: sample\n---\nbody';
		expect(frontmatter(toggleSkillFrontmatterDisabled(source, true))).toMatchObject({ "disable-model-invocation": true, metadata: "sample" });
	});

	it("leaves a missing flag unchanged when enabling, and rejects malformed YAML without an edit", () => {
		const source = '---\nname: fixture\ndescription: fixture\n---\nbody';
		expect(toggleSkillFrontmatterDisabled(source, false)).toBe(source);
		expect(() => toggleSkillFrontmatterDisabled('---\nname: [\n---\nbody', true)).toThrow(/invalid skill frontmatter/);
	});
});
