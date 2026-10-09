import { describe, expect, it } from "vitest";
import { splitMarkdownBlocks } from "../../../src/lib/ui/markdown-blocks";

describe("streaming markdown blocks", () => {
	it("splits finished blocks at blank lines and joins back to the original text", () => {
		const text = "## 标题\n\n第一段\n第二行\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n尾巴还在写";
		const blocks = splitMarkdownBlocks(text);
		expect(blocks).toEqual(["## 标题\n", "第一段\n第二行\n", "| a | b |\n| --- | --- |\n| 1 | 2 |\n", "尾巴还在写"]);
		expect(blocks.join("\n")).toBe(text);
		expect(splitMarkdownBlocks("")).toEqual([""]);
	});

	it("keeps code fences, lists and indented continuations in one block", () => {
		expect(splitMarkdownBlocks("```ts\nconst a = 1;\n\nconst b = 2;\n```\n\n后文")).toEqual(["```ts\nconst a = 1;\n\nconst b = 2;\n```\n", "后文"]);
		// 还没收尾的围栏：后面的空行与文字都算在代码块里
		expect(splitMarkdownBlocks("```\ncode\n\nmore")).toEqual(["```\ncode\n\nmore"]);
		// ``` 收不了 ~~~ 开的围栏，短的围栏也收不了长的
		expect(splitMarkdownBlocks("~~~\n```\n\nx\n~~~\n\ny")).toEqual(["~~~\n```\n\nx\n~~~\n", "y"]);
		expect(splitMarkdownBlocks("````\n```\n\nx")).toHaveLength(1);
		expect(splitMarkdownBlocks("1. 一\n\n2. 二\n\n   续行\n\n- 三")).toHaveLength(1);
		expect(splitMarkdownBlocks("段落\n\n    缩进代码")).toHaveLength(1);
	});
});
