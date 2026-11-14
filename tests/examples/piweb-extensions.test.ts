import { describe, expect, it } from "vitest";
import { sanitizeUiTree } from "@/lib/extension-ui";
import { buildTodoTree, renderTodoLines } from "../../examples/piweb-extensions/todo-panel";
import { buildReviewTree, renderReviewLines } from "../../examples/piweb-extensions/review-gate";
import { buildBoardTree, renderBoardLines } from "../../examples/piweb-extensions/status-board";
import type { WebUiNode } from "@/lib/types";

/** 样板树必须原样通过服务端校验（没有被裁剪/丢弃），否则说明样板写错了 */
function expectSurvives(tree: WebUiNode) {
	expect(sanitizeUiTree(tree)).toEqual(tree);
	return tree;
}

const walk = (node: WebUiNode): string[] => {
	const types: string[] = [node.type];
	if (node.type === "box") for (const child of node.children) types.push(...walk(child));
	return types;
};

describe("piweb extension samples", () => {
	it("todo panel produces a valid list tree with progress and toggle actions", () => {
		const tree = buildTodoTree([
			{ id: "1", title: "写测试", done: true },
			{ id: "2", title: "改文档", done: false },
		]);
		expectSurvives(tree);
		const types = walk(tree);
		expect(types).toContain("progress");
		expect(types).toContain("list");
		const listNode = JSON.stringify(tree);
		expect(listNode).toContain("toggle:1");
		expect(renderTodoLines([{ id: "1", title: "写测试", done: true }], 40)[0]).toContain("待办 1/1");
	});

	it("review gate keeps its diff inside a code node and offers three actions", () => {
		const tree = buildReviewTree({ title: "改动", summary: "2 个文件", diff: "+ a\n- b" });
		expectSurvives(tree);
		expect(walk(tree)).toEqual(["box", "text", "text", "code", "list"]);
		const text = JSON.stringify(tree);
		expect(text).toContain("\"action\":\"approve\"");
		expect(text).toContain("\"action\":\"changes\"");
		expect(renderReviewLines({ title: "改动", summary: "2 个文件", diff: "+ a" })[0]).toBe("改动");
	});

	it("status board renders a table plus a form whose fields survive sanitizing", () => {
		const tree = buildBoardTree(8);
		expectSurvives(tree);
		const json = JSON.stringify(tree);
		expect(json).toContain("\"type\":\"table\"");
		expect(json).toContain("\"concurrency\"");
		expect(json).toContain("\"paused\"");
		expect(renderBoardLines(8)[0]).toContain("并发 8");
	});
});
