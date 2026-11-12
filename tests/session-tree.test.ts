import { describe, expect, it } from "vitest";
import { buildSessionTree, SESSION_TREE_MAX_NODES } from "../src/lib/session-tree";

type Entry = { type: string; id: string; parentId: string | null; timestamp: string; message?: { role: string; content: unknown; timestamp: number } };

const iso = (ts: number) => new Date(ts).toISOString();
const user = (id: string, parentId: string | null, text: unknown, ts: number): Entry => ({ type: "message", id, parentId, timestamp: iso(ts), message: { role: "user", content: text, timestamp: ts } });
const reply = (id: string, parentId: string | null, ts: number): Entry => ({ type: "message", id, parentId, timestamp: iso(ts), message: { role: "assistant", content: [{ type: "text", text: "ok" }], timestamp: ts } });

/** 只实现 buildSessionTree 用到的那四个方法；当前分支 = 从叶子一路回到根 */
function sessionOf(entries: Entry[], leafId: string | null, labels: Record<string, string> = {}) {
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	return {
		getEntries: () => entries,
		getLeafId: () => leafId,
		getLabel: (id: string) => labels[id],
		getBranch: () => {
			const path: Entry[] = [];
			for (let current = leafId ? byId.get(leafId) : undefined; current; current = current.parentId ? byId.get(current.parentId) : undefined) path.unshift(current);
			return path;
		},
	} as unknown as Parameters<typeof buildSessionTree>[0];
}

const shape = (tree: ReturnType<typeof buildSessionTree>) => tree.nodes.map((node) => `${"  ".repeat(node.indent)}${node.forked ? "⑂" : "·"} ${node.text}${node.active ? "" : " (off)"}${node.current ? " *" : ""}`);

describe("会话树 → 分支列表", () => {
	it("直线对话平铺，不缩进", () => {
		const tree = buildSessionTree(sessionOf([user("u1", null, "第一问", 1), reply("a1", "u1", 2), user("u2", "a1", "第二问", 3), reply("a2", "u2", 4)], "a2"));
		expect(shape(tree)).toEqual(["· 第一问", "· 第二问 *"]);
		// 这条线上最新的叶子就是最后一条回答
		expect(tree.nodes.map((node) => node.leafId)).toEqual(["a2", "a2"]);
		expect(tree.nodes.map((node) => node.branches)).toEqual([1, 0]);
		expect(tree.leafId).toBe("a2");
		expect(tree.truncated).toBe(false);
	});

	it("编辑重发长出的分支：分叉处缩进并标出每一支的起点，旧分支不在当前路径上", () => {
		const tree = buildSessionTree(sessionOf([
			user("u1", null, "第一问", 1), reply("a1", "u1", 2),
			user("u2", "a1", "旧的第二问", 3), reply("a2", "u2", 4),
			// 回到 a1 之后重新提问
			user("u2b", "a1", "新的第二问", 5), reply("a2b", "u2b", 6),
			user("u3b", "a2b", "第三问", 7), reply("a3b", "u3b", 8),
		], "a3b"));
		expect(shape(tree)).toEqual([
			"· 第一问",
			"  ⑂ 旧的第二问 (off)",
			"  ⑂ 新的第二问",
			"  · 第三问 *",
		]);
		const [first, old, fresh] = tree.nodes;
		expect(first.branches).toBe(2);
		// 切到旧分支 = 把叶子挪到那条分支最新的位置；分叉点自己指向整棵子树里最新的叶子
		expect(old.leafId).toBe("a2");
		expect(fresh.leafId).toBe("a3b");
		expect(first.leafId).toBe("a3b");
	});

	it("第一问就被改过：两条起点并列，各自带着后续", () => {
		const tree = buildSessionTree(sessionOf([
			user("u1", null, "原来的开头", 1), reply("a1", "u1", 2),
			user("u1b", null, "改过的开头", 3), reply("a1b", "u1b", 4), user("u2b", "a1b", "接着问", 5),
		], "u2b"));
		expect(shape(tree)).toEqual(["⑂ 原来的开头 (off)", "⑂ 改过的开头", "· 接着问 *"]);
		// 最后一问还没有回答：它自己就是叶子
		expect(tree.nodes[2].leafId).toBe("u2b");
	});

	it("提问自己的标签和这一问之内（回答、工具结果）的标签分开给", () => {
		const tree = buildSessionTree(sessionOf(
			[user("u1", null, "第一问", 1), reply("a1", "u1", 2), user("u2", "a1", "第二问", 3), reply("a2", "u2", 4)],
			"a2",
			{ u2: "回滚点", a1: "好答案", a2: "终稿" },
		));
		// 没有标签的那一项不带这个键
		expect(tree.nodes[0].label).toBeUndefined();
		expect(tree.nodes[0].otherLabels).toEqual(["好答案"]);
		expect(tree.nodes[1]).toMatchObject({ label: "回滚点", otherLabels: ["终稿"] });
	});

	it("标题取提问首段：折叠空白、限长、技能展开还原成命令、多段内容拼起来", () => {
		const skill = '<skill name="review" location="/x/SKILL.md">\n很长的正文\n</skill>\n\nsrc/auth.ts';
		const tree = buildSessionTree(sessionOf([
			user("u1", null, "  多行\n\n  提问  ", 1),
			user("u2", "u1", skill, 2),
			user("u3", "u2", [{ type: "text", text: "看这张图" }, { type: "image", data: "…", mimeType: "image/png" }], 3),
			user("u4", "u3", "长".repeat(500), 4),
		], "u4"));
		expect(tree.nodes.map((node) => node.text).slice(0, 3)).toEqual(["多行 提问", "/skill:review src/auth.ts", "看这张图"]);
		expect(tree.nodes[3].text).toHaveLength(160);
	});

	it("几千层深的会话不爆栈，提问太多时截断并说明", () => {
		const entries: Entry[] = [];
		let parent: string | null = null;
		for (let i = 0; i < SESSION_TREE_MAX_NODES + 500; i += 1) {
			entries.push(user(`u${i}`, parent, `第 ${i} 问`, i * 2));
			entries.push(reply(`a${i}`, `u${i}`, i * 2 + 1));
			parent = `a${i}`;
		}
		const tree = buildSessionTree(sessionOf(entries, parent));
		expect(tree.nodes).toHaveLength(SESSION_TREE_MAX_NODES);
		expect(tree.truncated).toBe(true);
		expect(tree.nodes[0].text).toBe("第 0 问");
		// 最上面那一问之下最新的叶子是整条链的末尾
		expect(tree.nodes[0].leafId).toBe(parent);
	});

	it("空会话、没有提问的会话都给空列表", () => {
		expect(buildSessionTree(sessionOf([], null))).toEqual({ nodes: [], leafId: null, truncated: false });
		expect(buildSessionTree(sessionOf([reply("a1", null, 1)], "a1")).nodes).toEqual([]);
	});
});
