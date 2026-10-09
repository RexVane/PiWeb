/** 列表项开头（含有序列表）：空行后的列表项留在前一块，不把一个列表拆成两个 */
const LIST_ITEM = /^(?:[-*+]|\d{1,9}[.)])(?:\s|$)/;
/** 代码围栏：行首最多 3 个空格，再接至少 3 个 ` 或 ~ */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * 流式 Markdown 切块，供边生成边渲染：只在代码围栏外的空行处切开，且下一块要从第 0 列开始、不是列表项
 * （不拆开代码块、列表和缩进的续行）。块按 "\n" 拼回去就是原文；除最后一块外都已写完，渲染时可以各自记忆化。
 */
export function splitMarkdownBlocks(text: string): string[] {
	const lines = text.split("\n");
	const blocks: string[] = [];
	let start = 0;
	let fence: { char: string; size: number } | null = null;
	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i];
		const marker = FENCE.exec(line)?.[1];
		if (fence) {
			// 收尾围栏：同种字符、不短于开头，后面只能有空白
			if (marker && marker[0] === fence.char && marker.length >= fence.size && line.trim() === marker) fence = null;
			continue;
		}
		if (i > start && lines[i - 1].trim() === "" && line.trim() !== "" && !/^\s/.test(line) && !LIST_ITEM.test(line)) {
			blocks.push(lines.slice(start, i).join("\n"));
			start = i;
		}
		if (marker) fence = { char: marker[0], size: marker.length };
	}
	blocks.push(lines.slice(start).join("\n"));
	return blocks;
}
