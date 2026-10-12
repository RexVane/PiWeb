/**
 * @ 引用的模糊匹配与 pi harness 逐例对照。
 *
 * Web 端和终端里挑同一个文件，排序必须一致——否则同一个 `@que` 在两处给出不同结果是
 * 很难解释的 bug。这里直接把 pi-tui 的实现拿来当基准：
 * 固定用例 + 随机用例，逐条比对 `matches` 与 `score`（分数也要求完全相等，
 * 不只是「都命中了」），以及 fuzzyFilter 的最终顺序。
 *
 * pi-tui 是 pi-coding-agent 的传递依赖：装不上时跳过而不是失败
 * （跳过了就代表这条防线暂时没生效，不会伪装成通过）。
 */
import { describe, expect, it } from "vitest";
import { fuzzyFilter, fuzzyMatch } from "../src/lib/fuzzy";

const piFuzzy = await import("@earendil-works/pi-tui/dist/fuzzy.js").catch(() => null);
const withPi = piFuzzy ? it : it.skip;
if (!piFuzzy) console.warn("[fuzzy-parity] 取不到 pi-tui/fuzzy.js，本文件跳过");

const PATHS = [
	"src/components/ChatInput.tsx",
	"src/components/ChatWindow.tsx",
	"src/lib/fuzzy.ts",
	"src/lib/files-service.ts",
	"src/lib/agent-manager.ts",
	"docs/planning/technical-design.md",
	"docs/state/progress.md",
	"tests/git-service.test.ts",
	"package.json",
	"README.md",
	"src/app/api/files/route.ts",
	"a/b/c/deep/deeper/file.py",
	"libfoo/bar.py",
	"py3tool/main.rs",
	"src/lib/format.ts",
	"node_modules/ignored/x.js",
];

const QUERIES = [
	"",
	"a",
	"ci",
	"ChatIn",
	"chatinput",
	"CHAT",
	"fz",
	"fuzzy.ts",
	"lib",
	"lib/",
	"src/lib",
	"src/lib/for",
	"for",
	"py3",
	"3py",
	"route.ts",
	"progress",
	"docs/prog",
	"p",
	"ts",
	"tsx",
	"zzz",
	"src lib",
	"a/b/c",
	"nomatchever",
	"main.rs",
	"深度",
	"＠",
	"__proto__",
	"constructor",
];

function randomString(random: () => number, maxLength: number): string {
	const alphabet = "abcXYZ019._-/";
	let out = "";
	const length = Math.floor(random() * maxLength);
	for (let i = 0; i < length; i += 1) out += alphabet[Math.floor(random() * alphabet.length)];
	return out;
}

describe("@ 引用模糊匹配与 pi 一致", () => {
	withPi("固定用例的 matches 与 score 逐条相等", () => {
		const pi = piFuzzy as typeof import("@earendil-works/pi-tui/dist/fuzzy.js");
		let compared = 0;
		for (const text of PATHS) {
			for (const query of QUERIES) {
				const mine = fuzzyMatch(query, text);
				const theirs = pi.fuzzyMatch(query, text);
				expect({ query, text, ...mine }).toEqual({ query, text, ...theirs });
				compared += 1;
			}
		}
		expect(compared).toBe(PATHS.length * QUERIES.length);
	});

	withPi("随机用例的 matches 与 score 逐条相等（含大小写与数字互换）", () => {
		const pi = piFuzzy as typeof import("@earendil-works/pi-tui/dist/fuzzy.js");
		// 固定种子的伪随机：失败可复现，不依赖 Math.random 的运气
		let state = 123456789;
		const random = () => {
			state = (state * 1103515245 + 12345) % 2147483648;
			return state / 2147483648;
		};
		for (let i = 0; i < 2000; i += 1) {
			const text = randomString(random, 24) || "file.ts";
			const query = randomString(random, 6);
			expect({ query, text, ...fuzzyMatch(query, text) }).toEqual({ query, text, ...pi.fuzzyMatch(query, text) });
		}
	});

	withPi("fuzzyFilter 的命中集合与顺序完全一致", () => {
		const pi = piFuzzy as typeof import("@earendil-works/pi-tui/dist/fuzzy.js");
		const getText = (item: string) => item;
		for (const query of QUERIES) {
			expect(fuzzyFilter(PATHS, query, getText)).toEqual(pi.fuzzyFilter(PATHS, query, getText));
		}
		// 目录候选带尾斜杠（和界面显示一致），/ 切词的行为也要一致
		const dirs = ["src/", "src/lib/", "src/lib/deep/", "docs/", "tests/"];
		for (const query of ["lib", "lib/", "src/lib", "l/d"]) {
			expect(fuzzyFilter(dirs, query, getText), query).toEqual(pi.fuzzyFilter(dirs, query, getText));
		}
	});
});
