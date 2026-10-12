/**
 * @ 引用候选的纯逻辑：token 识别、文件夹推导、pi 同款的过滤 / 评分 / 排序。
 * 与 pi-tui 实现的逐例对照在 tests/mention-parity.test.ts。
 */
import { describe, expect, it } from "vitest";
import { MENTION_LIMIT, atToken, buildCandidates, candidateText, dirsOfPaths, suggestPaths } from "../src/lib/workspace-index";

function candidatesOf(files: string[]) {
	return buildCandidates(files, dirsOfPaths(files));
}

const FILES = [
	"src/lib/fuzzy.ts",
	"src/lib/files-service.ts",
	"src/a.ts",
	"src/components/ChatInput.tsx",
	"docs/state/progress.md",
	"docs/Reader.md",
	"README.md",
	"a.b.ts",
	"axb.ts",
];
const descriptions = (query: string) => suggestPaths(candidatesOf(FILES), query).map((item) => item.description);

describe("@ token 识别（pi 的 extractAtPrefix）", () => {
	it("光标前的词首 @ 才触发", () => {
		expect(atToken("@", 1)).toEqual({ query: "", start: 0, end: 1, tokenEnd: 1 });
		expect(atToken("@src/lib", 8)).toEqual({ query: "src/lib", start: 0, end: 8, tokenEnd: 8 });
		expect(atToken("看看这个 @fz", 8)).toMatchObject({ query: "fz", start: 5 });
		// 空白、引号、等号、中日韩标点之后都算词首；左括号类会被剥掉
		for (const prefix of ["x ", 'x"', "x'", "k=", "(", "`", "[", "，", "。", "「", "\t"]) {
			expect(atToken(`${prefix}@a`, prefix.length + 2), prefix).toMatchObject({ query: "a", start: prefix.length });
		}
	});

	it("邮箱、正文中间的 @、英文逗号后紧跟的 @ 都不触发（和 pi 一致）", () => {
		expect(atToken("someone@example.com", 18)).toBeNull();
		expect(atToken("a@b c", 5)).toBeNull();
		expect(atToken("a,@b", 4)).toBeNull();
		expect(atToken("中文@src", 6)).toBeNull();
		expect(atToken("没有引用", 4)).toBeNull();
	});

	it("光标在 token 中间时替换整段，不留半截", () => {
		expect(atToken("@libbar", 4)).toEqual({ query: "lib", start: 0, end: 4, tokenEnd: 7 });
		expect(atToken("@lib，后面", 2)).toEqual({ query: "l", start: 0, end: 2, tokenEnd: 4 });
	});

	it("支持 @\"带空格 的路径\"，有右引号时一起替换", () => {
		expect(atToken('看 @"my fi', 9)).toEqual({ query: "my fi", start: 2, end: 9, tokenEnd: 9 });
		expect(atToken('看 @"my fi" 后面', 9)).toEqual({ query: "my fi", start: 2, end: 9, tokenEnd: 10 });
	});

	it("只看光标所在的那一行", () => {
		expect(atToken("第一行\n@a", 6)).toMatchObject({ query: "a", start: 4 });
		// 上一行没配对的引号不影响这一行
		expect(atToken('"开头\n@a', 6)).toMatchObject({ query: "a", start: 4 });
	});
});

describe("候选集合", () => {
	it("文件夹由文件路径推导，且不含根目录", () => {
		expect(dirsOfPaths(["src/lib/fuzzy.ts", "src/components/ChatInput.tsx", "README.md"]).sort()).toEqual(["src", "src/components", "src/lib"]);
	});

	it("显示文本给目录补尾斜杠，文件原样", () => {
		expect(candidateText({ path: "src/lib", dir: true })).toBe("src/lib/");
		expect(candidateText({ path: "src/lib/fuzzy.ts", dir: false })).toBe("src/lib/fuzzy.ts");
	});
});

describe("匹配与排序（pi 的 getFuzzyFileSuggestions）", () => {
	it("空查询：先浅层，同层名字短的在前，再按字典序", () => {
		expect(descriptions("").slice(0, 6)).toEqual(["src", "docs", "a.b.ts", "axb.ts", "README.md", "src/a.ts"]);
	});

	it("默认只匹配文件名：@lib 给出 lib 文件夹，不列里面名字不含 lib 的文件", () => {
		expect(descriptions("lib")).toEqual(["src/lib"]);
		const [item] = suggestPaths(candidatesOf(FILES), "lib");
		expect(item).toMatchObject({ label: "lib/", candidate: { path: "src/lib", dir: true } });
	});

	it("全等 > 前缀 > 包含，同分时浅的、短的在前", () => {
		expect(descriptions("fi")).toEqual(["src/lib/files-service.ts"]);
		// 文件夹 src/ 与 state/ 是前缀命中（80 + 10），docs/ 与 components/ 是包含（50 + 10），文件都是包含（50）
		expect(descriptions("s")).toEqual([
			"src", "docs/state", "docs", "src/components",
			"a.b.ts", "axb.ts", "src/a.ts", "src/lib/fuzzy.ts", "docs/state/progress.md", "src/lib/files-service.ts", "src/components/ChatInput.tsx",
		]);
	});

	it("带 / 且目录存在：只在该目录下找，路径按用户打的前缀显示", () => {
		expect(descriptions("src/")).toEqual(["src/a.ts", "src/lib", "src/components", "src/lib/fuzzy.ts", "src/lib/files-service.ts", "src/components/ChatInput.tsx"]);
		expect(descriptions("src/l")).toEqual(["src/lib", "src/lib/files-service.ts"]);
		expect(descriptions("./src/l")).toEqual(["./src/lib", "./src/lib/files-service.ts"]);
		expect(descriptions("src/lib/../c")).toEqual(["src/lib/../components", "src/lib/../components/ChatInput.tsx", "src/lib/../lib/files-service.ts"]);
		expect(suggestPaths(candidatesOf(FILES), "./").map((item) => item.description).slice(0, 2)).toEqual(["./src", "./docs"]);
	});

	it("带 / 但目录不存在：按整条路径匹配（只命中路径包含查询的条目）", () => {
		expect(descriptions("rc/li")).toEqual(["src/lib", "src/lib/fuzzy.ts", "src/lib/files-service.ts"]);
		expect(descriptions("nope/x")).toEqual([]);
	});

	it("smart case：查询里有大写才区分大小写", () => {
		expect(descriptions("read")).toEqual(["README.md", "docs/Reader.md"]);
		expect(descriptions("Read")).toEqual(["docs/Reader.md"]);
	});

	it("查询按正则过滤、再按字面评分；JS 编不过的正则退回字面匹配", () => {
		expect(descriptions("a.b")).toEqual(["a.b.ts"]);
		// fd（Rust 正则）把 c++ 当 (c+)+；JS 报错 → 按字面，结果同样只剩名字里真有 c++ 的
		expect(suggestPaths(candidatesOf(["notes/c++.md", "cc.txt"]), "c++").map((item) => item.description)).toEqual(["notes/c++.md"]);
		expect(descriptions("c++")).toEqual([]);
	});

	it("工作区外的路径不支持", () => {
		expect(descriptions("../x")).toEqual([]);
		expect(descriptions("~/x")).toEqual([]);
		expect(descriptions("/etc/x")).toEqual([]);
	});

	it("最多 20 条，limit 只截断结果", () => {
		const many = Array.from({ length: 30 }, (_, i) => `f${String(i).padStart(2, "0")}.ts`);
		expect(suggestPaths(candidatesOf(many), "f")).toHaveLength(MENTION_LIMIT);
		expect(suggestPaths(candidatesOf(many), "f29").map((item) => item.label)).toEqual(["f29.ts"]);
		expect(suggestPaths(candidatesOf(many), "f", 2).map((item) => item.label)).toEqual(["f00.ts", "f01.ts"]);
	});
});
