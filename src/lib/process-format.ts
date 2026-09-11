/**
 * 对话过程行的纯文本整理：工具种类归类、命令去噪、路径相对化、思考首句、模型错误归类。
 * 不依赖 React，便于单测（tests/process-format.test.ts）。
 */

export type ToolKind = "cmd" | "read" | "search" | "write" | "other";

/** 工具名 → 种类（决定颜色与结果预览方式） */
export function toolKind(name: string): ToolKind {
	const n = name.toLowerCase();
	if (n === "bash" || n === "powershell" || n === "pwsh" || n === "shell" || n === "sh" || n === "cmd") return "cmd";
	if (n === "read") return "read";
	if (n === "grep" || n === "glob" || n === "find" || n === "ls" || n === "search") return "search";
	if (n === "edit" || n === "write" || n === "multiedit" || n === "multi_edit") return "write";
	return "other";
}

/** 统一为正斜杠；去掉包裹引号；MSYS 形式 /d/AIApp → D:/AIApp */
export function canonPath(p: string): string {
	let s = p.trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1").replace(/\\/g, "/");
	const msys = s.match(/^\/([a-zA-Z])\/(.*)$/);
	if (msys) s = `${msys[1].toUpperCase()}:/${msys[2]}`;
	return s;
}

function stripTrailingSlash(p: string): string {
	return p.replace(/\/+$/, "");
}

/** 工作区内的绝对路径显示为相对路径；工作区外原样（仅统一斜杠） */
export function relativizePath(path: string, cwd?: string): string {
	if (!path) return path;
	const p = canonPath(path);
	if (!cwd) return p;
	const root = stripTrailingSlash(canonPath(cwd));
	if (!root) return p;
	const pl = p.toLowerCase();
	const rl = root.toLowerCase();
	if (pl === rl) return ".";
	if (pl.startsWith(`${rl}/`)) return p.slice(root.length + 1);
	return p;
}

export function basename(p: string): string {
	const parts = canonPath(p).split("/").filter(Boolean);
	return parts[parts.length - 1] ?? p;
}

/**
 * 命令行摘要：去掉开头“cd <工作区> &&”这类噪音（目标恰为当前工作区时才去），
 * 折叠空白，只取首行；返回总行数供“…N 行”提示。
 */
export function cleanCommand(command: string, cwd?: string): { text: string; lines: number } {
	const raw = command.replace(/\r/g, "");
	const lines = raw.split("\n").filter((l) => l.trim().length > 0);
	let first = lines[0] ?? "";
	if (cwd) {
		const root = stripTrailingSlash(canonPath(cwd)).toLowerCase();
		// 允许连着多个 cd（极少见），逐个剥
		for (;;) {
			const m = first.match(/^\s*(?:cd|pushd)\s+(?:\/d\s+)?("[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*/);
			if (!m) break;
			const target = stripTrailingSlash(canonPath(m[1])).toLowerCase();
			if (target !== root) break;
			first = first.slice(m[0].length);
		}
	}
	let text = first.replace(/\s+/g, " ").trim();
	if (cwd) text = relativizeInText(text, cwd);
	return { text, lines: lines.length };
}

function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 把文本里出现的工作区绝对路径改成相对路径（正反斜杠、MSYS 形式都认）；单独出现的工作区本身变成 "." */
export function relativizeInText(text: string, cwd: string): string {
	const root = stripTrailingSlash(canonPath(cwd));
	if (!root) return text;
	const drive = root.match(/^([A-Za-z]):\/(.*)$/);
	const rest = drive ? drive[2] : root.replace(/^\//, "");
	// 路径分隔：正斜杠或（可能成对的）反斜杠
	const sep = "(?:\\/|\\\\+)";
	const restRe = escapeRe(rest).replace(/\//g, sep);
	const prefixRe = drive ? `(?:${drive[1]}:${sep}|/${drive[1]}/)` : "/";
	// 之后必须是分隔符、引号、空白或结尾，避免误伤 PiWebX 这类同前缀目录
	const re = new RegExp(`${prefixRe}${restRe}(?=\\/|\\\\|["'\\s]|$)(${sep})?`, "gi");
	return text.replace(re, (_m, tail?: string) => (tail ? "" : "."));
}

/** 思考摘要：取第一句（句末标点后接空白或结尾）；过短的首句退回整段截断 */
export function firstSentence(text: string, max = 140): string {
	const one = text.replace(/\s+/g, " ").trim();
	if (!one) return "";
	// 英文句号要求后接空白（避免 3.5 这种小数），中文句号不需要
	const m = one.match(/^.*?(?:[.!?](?=\s|$)|[。！？])/);
	let s = m ? m[0].trim() : one;
	// 首句过短（"OK."）时退回整段；中文按字算，阈值更低
	const min = /[㐀-鿿]/.test(s) ? 4 : 12;
	if (s.length < min && one.length > s.length) s = one;
	return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

export type ModelErrorKind = "rateLimit" | "billing" | "auth" | "notFound" | "context" | "timeout" | "server" | "network";

/** 把供应商原始报错归到少数几类，界面给一句人话；认不出返回 null（只显示原文） */
export function classifyModelError(message: string): ModelErrorKind | null {
	const m = message.toLowerCase();
	if (/\b429\b|rate.?limit|too many requests|requests per (minute|second)/.test(m)) return "rateLimit";
	if (/\b402\b|insufficient (balance|credits|quota|funds)|billing|quota exceeded|余额/.test(m)) return "billing";
	if (/\b401\b|\b403\b|unauthori[sz]ed|forbidden|invalid.*(api.?key|token)|authentication|permission denied/.test(m)) return "auth";
	if (/\b404\b|model.*not (found|exist)|unknown model|no such model|not_found_error/.test(m)) return "notFound";
	if (/context.*(length|window|limit)|too long|maximum.*tokens|prompt is too long|input length|exceeds the (limit|maximum)/.test(m)) return "context";
	if (/timeout|timed out|etimedout|\b408\b|\b504\b/.test(m)) return "timeout";
	if (/\b5\d\d\b|overloaded|server error|bad gateway|unavailable|internal error/.test(m)) return "server";
	if (/econnrefused|econnreset|enotfound|eai_again|fetch failed|network|socket hang up/.test(m)) return "network";
	return null;
}

/** 非空行（去 \r） */
export function splitLines(raw: string): string[] {
	return raw.replace(/\r/g, "").split("\n").filter((l) => l.trim().length > 0);
}

const EXT_LANG: Record<string, string> = {
	ts: "TypeScript", tsx: "TSX", js: "JavaScript", jsx: "JSX", mjs: "JavaScript", cjs: "JavaScript",
	py: "Python", rs: "Rust", go: "Go", java: "Java", kt: "Kotlin", rb: "Ruby", php: "PHP", cs: "C#",
	c: "C", h: "C", cpp: "C++", hpp: "C++", swift: "Swift", vue: "Vue", svelte: "Svelte",
	css: "CSS", scss: "SCSS", html: "HTML", json: "JSON", md: "Markdown", mdx: "MDX",
	yml: "YAML", yaml: "YAML", toml: "TOML", sh: "Shell", bash: "Shell", ps1: "PowerShell", sql: "SQL",
	xml: "XML", txt: "Text", lock: "Lock", env: "Env",
};

/** 由扩展名给一个语言名（read 行的元信息）；认不出返回空串 */
export function langOfPath(p: string): string {
	const name = basename(p).toLowerCase();
	if (name === "dockerfile") return "Dockerfile";
	if (name === "makefile") return "Makefile";
	const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
	return EXT_LANG[ext] ?? "";
}

const HEAD_VERBS = new Set([
	"cat", "ls", "dir", "tree", "find", "fd", "head", "tail", "type", "grep", "rg", "egrep", "fgrep", "ag", "sed", "awk",
	"echo", "printf", "less", "more", "which", "where", "env", "printenv", "set", "stat", "file", "ps", "curl", "wget", "jq",
]);
const GIT_HEAD_SUBS = new Set(["log", "status", "diff", "show", "branch", "ls-files", "blame", "remote", "stash", "tag", "config", "grep"]);

/** 命令输出预览取开头还是结尾：列表 / 查看类命令看开头，构建 / 测试 / 脚本类看结尾（结论在最后）；开头的 cd 一律跳过 */
export function previewSide(command: string): "head" | "tail" {
	let first = command.replace(/\r/g, "").split("\n").find((l) => l.trim().length > 0) ?? "";
	for (;;) {
		const m = first.match(/^\s*(?:cd|pushd)\s+(?:\/d\s+)?(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*/);
		if (!m) break;
		first = first.slice(m[0].length);
	}
	const tokens = first.trim().replace(/^(?:\w+=\S*\s+)+/, "").split(/\s+/);
	const verb = basename(tokens[0] ?? "").replace(/\.exe$/i, "").toLowerCase();
	if (verb === "git") return GIT_HEAD_SUBS.has((tokens[1] ?? "").toLowerCase()) ? "head" : "tail";
	return HEAD_VERBS.has(verb) ? "head" : "tail";
}

/** 去掉结尾只含括号 / 符号的行（"}"、");"、"$"），这些行做预览等于没看 */
export function trimNoiseTail(lines: string[]): string[] {
	let end = lines.length;
	while (end > 0 && !/[\p{L}\p{N}]/u.test(lines[end - 1])) end -= 1;
	return end === lines.length ? lines : lines.slice(0, end);
}
