import { isMap, isScalar, parseDocument } from "yaml";

/** Change only the root invocation flag; retain the original document's formatting and body. */
export function toggleSkillFrontmatterDisabled(content: string, disabled: boolean): string {
	const frontmatter = /^(\uFEFF?---[^\S\r\n]*)(\r\n|\n|\r)([\s\S]*?)(\r\n|\n|\r)---[^\S\r\n]*(?=\r\n|\n|\r|$)/.exec(content);
	if (!frontmatter) throw new Error("skill frontmatter is missing");
	const yaml = frontmatter[3];
	const document = parseDocument(yaml, { keepSourceTokens: true });
	if (document.errors.length || !isMap(document.contents)) throw new Error("invalid skill frontmatter");
	const key = "disable-model-invocation";
	const pair = document.contents.items.find((item) => isScalar(item.key) && item.key.value === key);
	let next: string;
	if (pair) {
		if (!isScalar(pair.value) || !pair.value.range) throw new Error("invalid skill invocation flag");
		if (pair.value.value === disabled) return content;
		const [start, end] = pair.value.range;
		const separator = start === end && yaml[start - 1] === ":" ? " " : "";
		next = yaml.slice(0, start) + separator + String(disabled) + yaml.slice(end);
	} else {
		if (!disabled) return content;
		if (document.contents.flow && document.contents.range) {
			const end = document.contents.range[1] - 1;
			next = yaml.slice(0, end) + `${document.contents.items.length ? ", " : ""}${key}: true` + yaml.slice(end);
		} else {
			const firstKey = document.contents.items[0]?.key;
			const offset = isScalar(firstKey) ? firstKey.range?.[0] : undefined;
			const lineStart = offset === undefined ? 0 : Math.max(yaml.lastIndexOf("\n", offset - 1), yaml.lastIndexOf("\r", offset - 1)) + 1;
			const indent = offset === undefined ? "" : /^ */.exec(yaml.slice(lineStart, offset))?.[0] ?? "";
			next = `${yaml}${frontmatter[2]}${indent}${key}: true`;
		}
	}
	if (parseDocument(next).errors.length) throw new Error("invalid skill frontmatter after updating invocation flag");
	const yamlStart = frontmatter[1].length + frontmatter[2].length;
	return content.slice(0, yamlStart) + next + content.slice(yamlStart + yaml.length);
}
