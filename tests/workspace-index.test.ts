/**
 * @ 引用候选的纯逻辑：token 识别（词首边界、光标位置）、文件夹推导、排序。
 * 与 pi 一致的匹配评分在 tests/fuzzy-parity.test.ts 里逐例对照。
 */
import { describe, expect, it } from "vitest";
import { atToken, buildCandidates, candidateText, dirsOfPaths, suggestPaths } from "../src/lib/workspace-index";

describe("@ token 识别", () => {
	it("光标前的词首 @ 才触发", () => {
		expect(atToken("@", 1)).toEqual({ query: "", start: 0, end: 1, tokenEnd: 1 });
		expect(atToken("@src/lib", 8)).toEqual({ query: "src/lib", start: 0, end: 8, tokenEnd: 8 });
		expect(atToken("看看这个 @fz", 8)).toMatchObject({ query: "fz", start: 5 });
		// 空格、引号、括号、中文标点之后都算词首
		for (const prefix of ["x ", 'x"', "(", "，", "\t"]) {
			expect(atToken(`${prefix}@a`, prefix.length + 2), prefix).toMatchObject({ query: "a", start: prefix.length });
		}
	});

	it("邮箱、正文中间的 @、以及单独一个 @ 之外的字符不触发", () => {
		expect(atToken("someone@example.com", 18)).toBeNull();
		expect(atToken("a@b c", 5)).toBeNull();
		expect(atToken("没有引用", 4)).toBeNull();
	});

	it("光标在 token 中间时替换整段，不留半截", () => {
		// `@lib|bar`：query 取光标前，但删除范围要盖住整个 token
		expect(atToken("@libbar", 4)).toEqual({ query: "lib", start: 0, end: 4, tokenEnd: 7 });
	});
});

describe("候选集合", () => {
	it("文件夹由文件路径推导，且不含根目录", () => {
		const dirs = dirsOfPaths(["src/lib/fuzzy.ts", "src/components/ChatInput.tsx", "README.md"]);
		expect(dirs.sort()).toEqual(["src", "src/components", "src/lib"]);
	});

	it("匹配文本给目录补尾斜杠，文件原样", () => {
		expect(candidateText({ path: "src/lib", dir: true })).toBe("src/lib/");
		expect(candidateText({ path: "src/lib/fuzzy.ts", dir: false })).toBe("src/lib/fuzzy.ts");
	});

	it("空 query 先列浅层（等价于先看当前目录），并遵守条数上限", () => {
		const candidates = buildCandidates(["src/lib/fuzzy.ts", "src/a.ts", "README.md"], ["src", "src/lib"]);
		const shallow = suggestPaths(candidates, "", 3).map(candidateText);
		// 最浅的三个：README.md（0 层）、src/、src/a.ts
		expect(shallow).toEqual(["README.md", "src/", "src/a.ts"]);
	});
	it("有 query 时按评分排序，文件夹和文件一起参与", () => {
		const candidates = buildCandidates(
			["src/lib/fuzzy.ts", "src/components/ChatInput.tsx", "docs/state/progress.md"],
			dirsOfPaths(["src/lib/fuzzy.ts", "src/components/ChatInput.tsx", "docs/state/progress.md"]),
		);
		expect(suggestPaths(candidates, "fuzzy", 10).map(candidateText)).toEqual(["src/lib/fuzzy.ts"]);
		// 目录只按它自己的路径匹配（`src/components/` 命中，`src/` 不命中：少了 components 这一段）
		// 同分时目录在前
		expect(suggestPaths(candidates, "src/components", 10).map(candidateText)).toEqual(["src/components/", "src/components/ChatInput.tsx"]);
		// 同分时目录在前（buildCandidates 的输入顺序）
		expect(suggestPaths(candidates, "lib", 10).map(candidateText)).toEqual(["src/lib/", "src/lib/fuzzy.ts"]);
		expect(suggestPaths(candidates, "zzz", 10)).toEqual([]);
	});

	it("limit 只截断结果，不改变匹配范围", () => {
		const candidates = buildCandidates(["a/x.ts", "a/y.ts", "a/z.ts"], []);
		expect(suggestPaths(candidates, "a", 2)).toHaveLength(2);
		expect(suggestPaths(candidates, "z", 1).map(candidateText)).toEqual(["a/z.ts"]);
	});
});
