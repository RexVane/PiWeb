/**
 * @ 引用与 pi 终端逐例对照：同一个 `@que`，网页和终端要给出同一批、同一顺序的候选。
 *
 * 直接拿 pi-tui 的 `CombinedAutocompleteProvider` 当基准：
 * - token 识别（extractAtPrefix）与评分（scoreEntry）逐条比，含随机用例；
 * - 分隔符正则核对 source，pi 升级改了规则这里会先红；
 * - 端到端：在临时目录里建同一批文件，pi 用真的 fd 跑 getSuggestions，结果（label + 路径）必须逐条相等。
 *   fd 不在 PATH 上就跳过这一条（跳过 ≠ 通过，会打警告）。
 *
 * 有意的差别见 src/lib/workspace-index.ts 顶部注释（不用 fd 的 100 条截断、不支持工作区外路径等），
 * 这里的夹具都在差别之外。pi-tui 是 pi-coding-agent 的传递依赖：取不到时整文件跳过。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	AUTOCOMPLETE_SEPARATOR_REGEX, CJK_BREAK_REGEX, atToken, buildCandidates, dirsOfPaths, scoreEntry, suggestPaths,
} from "../src/lib/workspace-index";

const piAutocomplete = await import("@earendil-works/pi-tui/dist/autocomplete.js").catch(() => null);
const piUtils = await import("@earendil-works/pi-tui/dist/utils.js").catch(() => null);
const withPi = piAutocomplete && piUtils ? it : it.skip;
if (!piAutocomplete || !piUtils) console.warn("[mention-parity] 取不到 pi-tui，本文件跳过");

/** pi 把这几个方法标成 private，运行时照样能调；pi 改名时这里会直接报错，正好提醒同步 */
interface PiInternals {
	extractAtPrefix(text: string): string | null;
	scoreEntry(filePath: string, query: string, isDirectory: boolean): number;
	getSuggestions(lines: string[], cursorLine: number, cursorCol: number, options: { signal: AbortSignal }): Promise<{ items: { label: string; description?: string }[]; prefix: string } | null>;
}

function piProvider(basePath: string, fdPath: string | null = null): PiInternals {
	const { CombinedAutocompleteProvider } = piAutocomplete!;
	return new CombinedAutocompleteProvider([], basePath, fdPath) as unknown as PiInternals;
}

/** 固定种子的伪随机：失败可复现 */
function seeded(seed: number) {
	let state = seed;
	return () => {
		state = (state * 1103515245 + 12345) % 2147483648;
		return state / 2147483648;
	};
}

function randomString(random: () => number, alphabet: readonly string[], maxLength: number): string {
	let out = "";
	const length = Math.floor(random() * maxLength);
	for (let i = 0; i < length; i += 1) out += alphabet[Math.floor(random() * alphabet.length)];
	return out;
}

describe("@ token 识别与 pi 一致", () => {
	withPi("分隔符规则和 pi-tui 的正则是同一个", () => {
		expect(CJK_BREAK_REGEX.source).toBe(piUtils!.cjkBreakRegex.source);
		expect(AUTOCOMPLETE_SEPARATOR_REGEX.source).toBe(piUtils!.autocompleteSeparatorRegex.source);
	});

	/** 我们的 token（从 start 到光标）就是 pi 的 extractAtPrefix 返回值 */
	const mine = (text: string) => {
		const token = atToken(text, text.length);
		return token ? text.slice(token.start, token.end) : null;
	};

	withPi("固定用例", () => {
		const pi = piProvider(process.cwd());
		const cases = [
			"@", "@src/lib", "看看这个 @fz", "x @a", 'x"@a', "x'@a", "k=@a", "(@a", "((@a", "[@a", "{@a", "<@a", "`@a", "(@a)", "app/[slug]/@x",
			"，@a", "。@a", "「@a", "（@a", "\t@a", "someone@example.com", "a@b c", "a,@b", "a;@b", "中文@src", "中文 @src", "@@a", "@a@b",
			'@"my fi', 'x @"my file', 'say "hi" @"a b', '"@a', 'x"y @"z', '(@"a b', "＠a", "@src/lib/../c", "@./src", "@~/x", "@C:\\x",
		];
		for (const text of cases) expect({ text, prefix: mine(text) }).toEqual({ text, prefix: pi.extractAtPrefix(text) });
	});

	withPi("随机用例", () => {
		const pi = piProvider(process.cwd());
		const random = seeded(20261013);
		const alphabet = ["@", "@", "a", "b", "/", ".", " ", "\t", '"', "'", "=", "(", ")", "[", "]", "{", "<", "`", ",", "，", "。", "「", "中", "あ", "한", "x"];
		for (let i = 0; i < 3000; i += 1) {
			const text = randomString(random, alphabet, 12);
			expect({ text, prefix: mine(text) }).toEqual({ text, prefix: pi.extractAtPrefix(text) });
		}
	});
});

describe("评分与 pi 一致", () => {
	withPi("scoreEntry 逐条相等（文件 / 目录、大小写、路径包含）", () => {
		const pi = piProvider(process.cwd());
		const paths = ["src/lib/fuzzy.ts", "src/lib/", "lib/", "README.md", "docs/Reader.md", "a.b.ts", "src/components/ChatInput.tsx", "中文 说明.md", "c++.md", "x/"];
		const queries = ["", "lib", "LIB", "li", "ib", "src/lib", "rc/li", "fuzzy.ts", "FUZZY", "read", "Read", "a.b", "md", "说明", "c++", "zzz", "x"];
		for (const filePath of paths) {
			for (const query of queries) {
				for (const dir of [false, true]) {
					expect({ filePath, query, dir, score: scoreEntry(filePath, query, dir) }).toEqual({ filePath, query, dir, score: pi.scoreEntry(filePath, query, dir) });
				}
			}
		}
	});
});

const FD = spawnSync("fd", ["--version"], { encoding: "utf8" }).status === 0 ? "fd" : null;
const withFd = piAutocomplete && piUtils && FD ? it : it.skip;
if (piAutocomplete && !FD) console.warn("[mention-parity] PATH 上没有 fd，端到端对照跳过");

// 总条目（文件 + 目录）少于 100：pi 每次 fd 只取前 100 条，夹具要在这个范围内才是逐条可比的
const FIXTURE = [
	"README.md", "readme-old.txt", "package.json", "a.b.ts", "axb.ts", ".env.example",
	".github/workflows/ci.yml",
	"src/index.ts", "src/lib/fuzzy.ts", "src/lib/files-service.ts", "src/lib/Format.ts", "src/lib/deep/deeper/leaf.ts",
	"src/components/ChatInput.tsx", "src/components/chat-window.tsx",
	"src/app/[slug]/page.tsx", "src/app/(group)/layout.tsx",
	"docs/state/progress.md", "docs/Reader.md", "docs/中文 说明.md",
	"notes/c++.md", "lib/root-lib.ts", "tests/workspace-index.test.ts",
];

describe("端到端：同一批文件，pi（真 fd）与网页给出同样的候选", () => {
	let root = "";
	beforeAll(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-mention-parity-"));
		for (const file of FIXTURE) {
			await fs.mkdir(path.join(root, path.dirname(file)), { recursive: true });
			await fs.writeFile(path.join(root, file), "x");
		}
	});
	afterAll(async () => {
		if (root) await fs.rm(root, { recursive: true, force: true });
	});

	withFd("各类查询逐条相等：空查询、文件名、限定目录、整条路径、smart case、正则字符", async (ctx) => {
		const pi = piProvider(root, FD);
		const candidates = buildCandidates(FIXTURE, dirsOfPaths(FIXTURE));
		const signal = new AbortController().signal;
		const piItems = async (query: string) => {
			const line = `@${query}`;
			const result = await pi.getSuggestions([line], 0, line.length, { signal });
			return (result?.items ?? []).map((item) => ({ label: item.label, description: item.description }));
		};
		// fd 被全局忽略规则挡住（比如临时目录落在某个仓库里）时，对照没有意义
		if (!(await piItems("")).length) {
			console.warn("[mention-parity] fd 在临时目录里列不出文件，端到端对照跳过");
			ctx.skip();
		}
		const queries = [
			"", "s", "src", "src/", "src/l", "src/lib/", "./src/l", "src/lib/../c", "lib", "LIB", "Format", "format", "fo", "read", "Read",
			"a.b", "c++", "rc/li", "nope/x", "page", "[slug]", "src/app/[slug]/", "(group)", "中文", "说明", ".github/", "deep/", "src/lib/deep/deeper/",
			"tsx", "t", "x", "ci", ".env",
		];
		let nonEmpty = 0;
		for (const query of queries) {
			const mine = suggestPaths(candidates, query).map(({ label, description }) => ({ label, description }));
			expect({ query, items: mine }).toEqual({ query, items: await piItems(query) });
			if (mine.length) nonEmpty += 1;
		}
		// 防止「两边都是空」的假通过：只有 LIB、nope/x 这类少数查询本该没有候选
		expect(nonEmpty).toBeGreaterThanOrEqual(queries.length - 4);
	});
});
