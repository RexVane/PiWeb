// @vitest-environment jsdom
/**
 * 流式渲染：块切分（保留）+ 文本到达即整段显示。
 * - 切分只在围栏外空行处发生，围栏内 / 松散列表内部不切，保证流式期间 Markdown 结构正确；
 * - 显示不再做逐帧平滑：文本一到就整段渲染，只保留「结束时换成整段渲染」与「贴底」这两条行为。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { StreamingMarkdownBlock, createStreamingSplitter, splitOpenFence, splitStreamingMarkdown } from "@/components/MarkdownBlock";
import { ChatScrollContext } from "@/components/chat/chat-scroll";

afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

describe("splitStreamingMarkdown", () => {
	it("在围栏外空行处切出稳定块，尾巴保留最后一段", () => {
		const { blocks, tail, tailInFence } = splitStreamingMarkdown("第一段。\n\n第二段\n\n第三段在写");
		expect(blocks).toEqual(["第一段。\n\n", "第二段\n\n"]);
		expect(tail).toBe("第三段在写");
		expect(tailInFence).toBe(false);
	});

	it("代码围栏内的空行不切块，并标记 tailInFence", () => {
		const text = "说明：\n\n```python\ndef f():\n\n    return 1\n";
		const { blocks, tail, tailInFence } = splitStreamingMarkdown(text);
		expect(blocks).toEqual(["说明：\n\n"]);
		expect(tail).toBe("```python\ndef f():\n\n    return 1\n");
		expect(tailInFence).toBe(true);
	});

	it("围栏闭合后不再是 tailInFence", () => {
		const text = "```js\nlet a = 1;\n```\n\n后面";
		const { blocks, tail, tailInFence } = splitStreamingMarkdown(text);
		expect(blocks).toEqual(["```js\nlet a = 1;\n```\n\n"]);
		expect(tail).toBe("后面");
		expect(tailInFence).toBe(false);
	});

	it("松散有序列表内部的空行不切块（序号不重排）", () => {
		const { blocks, tail } = splitStreamingMarkdown("1. 甲\n\n2. 乙\n");
		expect(blocks).toEqual([]);
		expect(tail).toBe("1. 甲\n\n2. 乙\n");
	});

	it("段落 -> 列表 的边界照常切块", () => {
		const { blocks, tail } = splitStreamingMarkdown("前言。\n\n- 甲\n- 乙\n");
		expect(blocks).toEqual(["前言。\n\n"]);
		expect(tail).toBe("- 甲\n- 乙\n");
	});

	it("围栏里的 ```js、更短的 ``` 都不算闭合（CommonMark）", () => {
		const withInfo = splitStreamingMarkdown("````md\n```js\n\nx\n```\n\n还在里面\n");
		expect(withInfo.blocks).toEqual([]);
		expect(withInfo.tailInFence).toBe(true);
		const closed = splitStreamingMarkdown("```\n```js\n\n```\n\n后面");
		expect(closed.blocks).toEqual(["```\n```js\n\n```\n\n"]);
		expect(closed.tail).toBe("后面");
	});

	it("列表项下面缩进的续段不切开，续段之后的下一项也还在同一个列表里", () => {
		const { blocks, tail } = splitStreamingMarkdown("1. 甲\n\n   甲的续段\n\n2. 乙\n\n正文\n");
		expect(blocks).toEqual(["1. 甲\n\n   甲的续段\n\n2. 乙\n\n"]);
		expect(tail).toBe("正文\n");
	});
});

describe("splitOpenFence", () => {
	it("开头的 ``` 行不进代码，围栏前的文字单独交给 Markdown", () => {
		expect(splitOpenFence("说明：\n```python\ndef f():\n    return 1\n")).toEqual({
			before: "说明：\n",
			lang: "python",
			code: "def f():\n    return 1\n",
		});
	});

	it("正在敲、还没换行的闭合行不露出来", () => {
		expect(splitOpenFence("```js\nlet a = 1;\n``").code).toBe("let a = 1;\n");
		expect(splitOpenFence("~~~\nx\n~~").code).toBe("x\n");
		// 不同字符的半行是代码本身
		expect(splitOpenFence("~~~\nx\n``").code).toBe("x\n``");
	});
});

describe("createStreamingSplitter 增量切分", () => {
	const samples = [
		"第一段。\n\n第二段\n\n第三段在写",
		"说明：\n\n```python\ndef f():\n\n    return 1\n",
		"```js\nlet a = 1;\n```\n\n后面",
		"1. 甲\n\n2. 乙\n",
		"1. 甲\n\n2. 乙",
		"1. 甲\n\n2.",
		"甲\n\n",
		"甲\n\n乙",
		"前言。\n\n- 甲\n- 乙\n\n正文",
		"````md\n```js\n\nx\n```\n\n还在里面\n````\n\n后面",
		"1. 甲\n\n   甲的续段\n\n2. 乙\n\n正文",
		"- 甲\n懒续行\n\n- 乙\n\n```\n\n```\n\n尾巴",
	];

	it("逐字喂进去的结果与一次性切分一致（边界不因增量而漂移）", () => {
		for (const text of samples) {
			const splitter = createStreamingSplitter();
			let incremental = splitter.update("");
			for (let i = 1; i <= text.length; i += 1) incremental = splitter.update(text.slice(0, i));
			expect(incremental).toEqual(splitStreamingMarkdown(text));
		}
	});

	it("半行不判：下一行还没写完时不急着切（松散列表不会被切开）", () => {
		const splitter = createStreamingSplitter();
		splitter.update("1. 甲\n\n2.");
		expect(splitter.update("1. 甲\n\n2. 乙\n").blocks).toEqual([]);
	});

	it("文本被整体替换（编辑重发）时重头扫，不沿用旧进度", () => {
		const splitter = createStreamingSplitter();
		splitter.update("第一段。\n\n第二段");
		expect(splitter.update("重来\n\n另一段")).toEqual(splitStreamingMarkdown("重来\n\n另一段"));
	});
});

describe("StreamingMarkdownBlock 即时渲染", () => {
	// 文本到达即整段显示：不再做逐帧平滑（模型吐字速度由上游与网络决定，
	// 本地再加一层追赶节奏只会让显示落后于实际到达的内容）。
	it("文本到达即整段显示", () => {
		const target = "abcdefghij".repeat(20); // 200 字符
		const { container, rerender } = render(<StreamingMarkdownBlock text={target.slice(0, 20)} />);
		rerender(<StreamingMarkdownBlock text={target} />);
		expect(container.textContent).toBe(target);
	});

	it("未闭合的代码块：开头的 ``` 行不显示，结构和最终渲染一样是 pre > code（不折行）", () => {
		const { container } = render(<StreamingMarkdownBlock text={"说明：\n\n```python\ndef f():\n"} />);
		const code = container.querySelector(".md-code-block > pre > code");
		expect(code?.textContent).toBe("def f():\n");
		expect(code?.className).toBe("hljs language-python");
		expect(container.textContent).not.toContain("```");
	});

	it("回答结束后换成整段渲染（与历史消息同一种渲染）", () => {
		const target = "a".repeat(30);
		const { container, rerender } = render(<StreamingMarkdownBlock text="" />);
		rerender(<StreamingMarkdownBlock text={target} />);
		expect(container.textContent).toBe(target);
		expect(container.querySelector(".pw-stream")).not.toBeNull();
		rerender(<StreamingMarkdownBlock text={target} live={false} />);
		// 结束后交给整段渲染：脚注、引用式链接这类跨块语法才对
		expect(container.querySelector(".pw-stream")).toBeNull();
		expect(container.querySelector(".md")).not.toBeNull();
		expect(container.textContent).toBe(target);
	});

	it("贴底听对话区的：对话区说不贴就不贴，说贴才贴", () => {
		const pin = vi.fn();
		let stuck = false;
		const scroll = { shouldPin: () => stuck, pin };
		const ui = (text: string) => (
			<ChatScrollContext.Provider value={scroll}>
				<StreamingMarkdownBlock text={text} />
			</ChatScrollContext.Provider>
		);
		const { rerender } = render(ui(""));
		rerender(ui("abcdefghij".repeat(10)));
		expect(pin).not.toHaveBeenCalled();
		stuck = true;
		rerender(ui("abcdefghij".repeat(10) + "k"));
		expect(pin).toHaveBeenCalled();
	});
});
