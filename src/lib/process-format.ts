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

/** 展示层路径压缩：工作区内保持相对路径；临时目录缩成 Temp/…，家目录缩成 ~/…（保留完整路径在 tooltip） */
export function compactDisplayPath(path: string, cwd?: string): string {
	const rel = relativizePath(path, cwd);
	if (!rel) return rel;
	const tempWin = rel.match(/\/AppData\/Local\/Temp\/(.+)$/i);
	if (tempWin) return `Temp/${tempWin[1]}`;
	const tempMac = rel.match(/^\/private\/var\/folders\/[^/]+\/[^/]+\/T\/(.+)$/);
	if (tempMac) return `Temp/${tempMac[1]}`;
	const tempUnix = rel.match(/^\/tmp\/(.+)$/);
	if (tempUnix) return `Temp/${tempUnix[1]}`;
	const home = rel.match(/^(?:[A-Za-z]:)?\/(?:Users|home)\/[^/]+\/(.+)$/);
	if (home) return `~/${home[1]}`;
	return rel;
}

export function basename(p: string): string {
	const parts = canonPath(p).split("/").filter(Boolean);
	return parts[parts.length - 1] ?? p;
}

/**
 * 识别对 `SKILL.md` 的读取调用，按官方 Pi CLI `read` 渲染器约定返回其父目录名（作为技能名）；
 * 非 `read` 调用、或目标文件名不是精确的 `SKILL.md` 时返回 null。
 */
export function skillNameFromRead(name: string, args: unknown): string | null {
	if (toolKind(name) !== "read") return null;
	if (!args || typeof args !== "object") return null;
	const a = args as Record<string, unknown>;
	const raw = typeof a.path === "string" ? a.path : typeof a.file_path === "string" ? a.file_path : "";
	if (!raw) return null;
	const parts = stripTrailingSlash(canonPath(raw)).split("/").filter(Boolean);
	if (parts.length === 0 || parts[parts.length - 1] !== "SKILL.md") return null;
	const parent = parts.length >= 2 ? parts[parts.length - 2] : "";
	if (!parent || parent === "." || parent === ".." || /^[a-zA-Z]:$/.test(parent)) return "SKILL.md";
	return parent;
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
	text = dropEchoSeparators(text);
	if (cwd) text = relativizeInText(text, cwd);
	return { text, lines: lines.length };
}

/** 上下文 token 估算口径：与 SDK estimateTokens 一致的字符/4 */
export function estimateTokensOf(text: string): number {
	return Math.ceil(text.length / 4);
}

/**
 * 上下文 13 类分段中的 5 个消息分项：按 role / content.type 归类字符数。
 * 扩展注入的消息（custom）和用户的 `!` 命令（bashExecution）在发给模型时都被 pi 转成用户内容，算在 user 里；
 * `!!` 命令（excludeFromContext）不进上下文，不算。
 */
export function classifyMessageChars(
	messages: Array<{
		role?: string;
		content: Array<{ type: string; text?: string; thinking?: string; arguments?: unknown }>;
		bash?: { command: string; output: string; excludeFromContext?: boolean };
	}>,
): { user: number; agentText: number; agentThinking: number; agentToolCall: number; toolOutput: number } {
	const out = { user: 0, agentText: 0, agentThinking: 0, agentToolCall: 0, toolOutput: 0 };
	for (const message of messages) {
		if (message.role === "bashExecution") {
			if (message.bash && !message.bash.excludeFromContext) out.user += message.bash.command.length + message.bash.output.length;
			continue;
		}
		for (const content of message.content) {
			if (content.type === "text") {
				const chars = content.text?.length ?? 0;
				if (message.role === "user" || message.role === "custom") out.user += chars;
				else if (message.role === "toolResult") out.toolOutput += chars;
				else if (message.role !== "system") out.agentText += chars;
			} else if (content.type === "thinking") {
				out.agentThinking += content.thinking?.length ?? 0;
			} else if (content.type === "toolCall") {
				out.agentToolCall += ((content as { name?: string }).name?.length ?? 0) + JSON.stringify(content.arguments ?? "").length;
			} else if (content.type === "toolResult") {
				out.toolOutput += (content as { text?: string }).text?.length ?? 0;
			}
		}
	}
	return out;
}

/** 删除文件的命令：rm / Remove-Item / del / trash 等，且至少带一个非选项参数 */
const DELETE_COMMANDS = new Set(["rm", "remove-item", "ri", "del", "erase", "unlink", "trash"]);

/**
 * 单条命令是否是删除。只看该段的第一个词，所以必须按 ; && || 先切段——
 * `cd src && rm main.py` 这种链式写法以前整条都判不出来。
 */
function isDeleteSegment(segment: string): boolean {
	const tokens = segment.trim().split(/\s+/).filter(Boolean);
	if (!tokens.length) return false;
	const base = (tokens[0].split(/[\\/]/).pop() ?? tokens[0]).toLowerCase().replace(/\.(exe|ps1|bat|cmd)$/, "");
	// git rm <path>：删除动作在第二个词
	if (base === "git") return tokens[1]?.toLowerCase() === "rm" && tokens.slice(2).some((tok) => !tok.startsWith("-"));
	if (!DELETE_COMMANDS.has(base)) return false;
	return tokens.slice(1).some((tok) => !tok.startsWith("-"));
}

/** bash/PowerShell 删除文件的命令判定（支持链式命令，逐段判断，避免误判整条） */
export function isDeleteCommand(command: string): boolean {
	return splitTopLevel(command).some(isDeleteSegment);
}

/** 从删除命令里提取第一个目标路径（去引号；相对路径解析交给展示层） */
export function deleteTargetOf(command: string): string {
	for (const segment of splitTopLevel(command)) {
		if (!isDeleteSegment(segment)) continue;
		const tokens = segment.trim().match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
		const skip = tokens[0]?.toLowerCase() === "git" ? 2 : 1;
		const target = tokens.slice(skip).find((tok) => !tok.startsWith("-"));
		if (target) return target.replace(/^["']|["']$/g, "");
	}
	return "";
}

/** 按顶层的 ; && || 切分（引号内不切） */
function splitTopLevel(cmd: string): string[] {
	const parts: string[] = [];
	let cur = "";
	let quote: string | null = null;
	for (let i = 0; i < cmd.length; i += 1) {
		const ch = cmd[i];
		if (quote) {
			cur += ch;
			if (ch === quote && cmd[i - 1] !== "\\") quote = null;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			cur += ch;
			continue;
		}
		if (ch === ";") {
			parts.push(cur);
			cur = "";
			continue;
		}
		if ((ch === "&" && cmd[i + 1] === "&") || (ch === "|" && cmd[i + 1] === "|")) {
			parts.push(cur);
			cur = "";
			i += 1;
			continue;
		}
		cur += ch;
	}
	parts.push(cur);
	return parts;
}

/**
 * 去掉只起分隔/标题作用的 echo 段（echo "═══ rag ═══"; echo ---; echo ""），只留真正的命令。
 * 带变量的 echo（echo "EXIT=$?"）是结果输出，保留。全是分隔段就原样返回。
 */
export function dropEchoSeparators(cmd: string): string {
	const parts = splitTopLevel(cmd).map((p) => p.trim());
	if (parts.length < 2) return cmd;
	const isSeparator = (p: string): boolean => {
		const m = p.match(/^echo(?:\s+-[ne]+)?\s*(?:"([^"]*)"|'([^']*)'|(\S*))?$/);
		if (!m) return false;
		const payload = m[1] ?? m[2] ?? m[3] ?? "";
		if (payload.includes("$")) return false;
		if (/^[\s\-=─═—#*~_.>]*$/.test(payload)) return true;
		return /[─═=\-#*~]{3,}/.test(payload);
	};
	const kept = parts.filter((p) => p && !isSeparator(p));
	if (!kept.length || kept.length === parts.filter(Boolean).length) return cmd;
	return kept.join("; ");
}

const TOOL_DISPLAY: Record<string, string> = {
	bash: "Bash",
	powershell: "PowerShell",
	pwsh: "PowerShell",
	shell: "Shell",
	read: "Read",
	edit: "Edit",
	multiedit: "MultiEdit",
	multi_edit: "MultiEdit",
	write: "Write",
	grep: "Grep",
	glob: "Glob",
	find: "Find",
	ls: "List",
	search: "Search",
};

/** 工具名的展示写法（Claude Code 式的 Bash / Read / Edit…），未知工具首字母大写 */
export function displayToolName(name: string): string {
	const n = name.toLowerCase();
	return TOOL_DISPLAY[n] ?? (name.charAt(0).toUpperCase() + name.slice(1));
}

const LIST_VERBS = new Set(["ls", "dir", "tree", "find", "fd"]);

/** 命令的动词（去掉环境变量前缀与路径） */
export function commandVerb(command: string): string {
	const first = command.replace(/\r/g, "").split("\n").find((l) => l.trim().length > 0) ?? "";
	const tokens = first.trim().replace(/^(?:\w+=\S*\s+)+/, "").split(/\s+/);
	return basename(tokens[0] ?? "").replace(/\.exe$/i, "").toLowerCase();
}

/** 列目录类命令（Codex 的「Listed」） */
export function isListCommand(command: string): boolean {
	return LIST_VERBS.has(commandVerb(command));
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

export type ModelErrorKind = "rateLimit" | "billing" | "auth" | "notFound" | "context" | "timeout" | "server" | "network" | "moderation";

/** 把供应商原始报错归到少数几类，界面给一句人话；认不出返回 null（只显示原文） */
export function classifyModelError(message: string): ModelErrorKind | null {
	const m = message.toLowerCase();
	// Content moderation (gateway-side sensitive-word filters) must be checked before
	// the generic 5xx rule: such gateways often answer with a misleading 500.
	if (/sensitive[ _-]?words?|content (moderation|filter)|moderation|content_policy|content policy|input blocked/.test(m)) return "moderation";
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

// ---------- 命令意图提炼（将冗长 Shell 脚手架转为紧凑人话标签） ----------

export type CommandIntentCategory =
	| "port_proc"
	| "dir_list"
	| "code_search"
	| "file_read"
	| "script_py"
	| "script_node"
	| "test_check"
	| "type_check"
	| "build"
	| "git_inspect"
	| "git_write"
	| "net_capture"
	| "sqlite"
	| "http"
	| "env_probe";

export interface CommandIntent {
	category: CommandIntentCategory;
	/** 提炼出的关键目标（端口、路径、测试文件或工具名）；为空时退回默认摘要 */
	target: string;
	lines: number;
}

const SHELL_PATH_TOKEN = /"([^"]+)"|'([^']+)'|(\S+)/g;

function extractTokens(segment: string): string[] {
	const out: string[] = [];
	for (const m of segment.matchAll(SHELL_PATH_TOKEN)) {
		const raw = m[1] ?? m[2] ?? m[3] ?? "";
		if (raw) out.push(raw);
	}
	return out;
}

function unquote(s: string): string {
	return s.replace(/^["']|["']$/g, "").trim();
}

function compactTarget(s: string, max = 64): string {
	const clean = s.replace(/\s+/g, " ").trim();
	return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

function peelLeadingCd(text: string): { dirHint: string; body: string } {
	let body = text.trim();
	let dirHint = "";
	for (;;) {
		const envPs = body.match(/^(?:\$env:[A-Za-z0-9_]+\s*=\s*(?:"[^"]*"|'[^']*'|\S+)|set\s+[A-Za-z0-9_]+=[^\s&;]+)\s*(?:&&|;)\s*(.+)$/i);
		if (envPs) {
			body = envPs[1].trim();
			continue;
		}
		const m = body.match(/^(?:cd|pushd|Set-Location)\s+(?:\/d\s+)?("[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*(.+)$/i);
		if (!m) break;
		dirHint = compactDisplayPath(unquote(m[1]));
		body = m[2].trim();
	}
	return { dirHint, body };
}

function isNoiseTarget(s: string): boolean {
	const t = s.trim();
	if (!t || t === "Temp") return true;
	if (/^[.*…_-]+$/.test(t)) return true;
	if (/^\*+(?:[/.][^*]+)?$/.test(t) || /^\*\.[a-z0-9]+$/i.test(t)) return true;
	if (/^\d+$/.test(t)) return true;
	return false;
}

function normalizeShellPathToken(raw: string, cwd?: string): string {
	const cleaned = unquote(raw).replace(/\$env:([A-Za-z0-9_]+)/gi, "%$1%");
	if (!cleaned || cleaned.startsWith("-")) return "";
	const out = compactDisplayPath(cleaned, cwd);
	return isNoiseTarget(out) ? "" : out;
}

const PATH_FLAG_WITH_VALUE = /^-(?:filter|include|exclude|depth|erroraction|ea|encoding|sort|totalcount|tail|head|first|last|skip|select|context|pattern|l|n|c|f|m|i)$/i;

function extractPathsFromArgs(segment: string, cwd?: string): string[] {
	const tokens = extractTokens(segment).slice(1);
	const paths: string[] = [];
	for (let i = 0; i < tokens.length; i += 1) {
		const tok = tokens[i];
		if (tok === "|" || tok === ">" || tok === ">>" || tok.startsWith("2>")) break;
		if (tok.startsWith("-")) {
			// 跳过带参数标志的值，避免 SilentlyContinue / TotalCount 60 / *.ts 等进入路径列表
			if (!tok.includes("=") && PATH_FLAG_WITH_VALUE.test(tok)) i += 1;
			continue;
		}
		if (tok === "," || tok === "&&" || tok === ";") continue;
		for (const piece of tok.split(",")) {
			const normalized = normalizeShellPathToken(piece, cwd);
			if (normalized) paths.push(normalized);
		}
		if (paths.length >= 2) break;
	}
	return [...new Set(paths)];
}

const SEARCH_VALUE_FLAGS = new Set([
	"-a", "-b", "-c", "-m", "-g", "-t", "-f",
	"--glob", "--iglob", "--type", "--type-not",
	"--max-count", "--max-depth", "--context", "--after-context", "--before-context",
	"-j", "--threads", "--sort", "--color", "--encoding",
	"-filter", "-include", "-exclude", "-context", "-encoding",
]);

function extractSearchIntent(tokensAfterVerb: string[], cwd?: string, dirHint = ""): string {
	let explicitPattern = "";
	const pos: string[] = [];
	for (let i = 0; i < tokensAfterVerb.length; i += 1) {
		const tok = tokensAfterVerb[i];
		if (tok === "|" || tok === ">" || tok === ">>" || tok.startsWith("2>")) break;
		const low = tok.toLowerCase();
		if (low === "-e" || low === "--regexp" || low === "-pattern") {
			if (i + 1 < tokensAfterVerb.length) {
				explicitPattern = unquote(tokensAfterVerb[i + 1]);
				i += 1;
			}
			continue;
		}
		if (tok.startsWith("-")) {
			if (!tok.includes("=") && SEARCH_VALUE_FLAGS.has(low)) i += 1;
			continue;
		}
		pos.push(unquote(tok));
	}
	const rawPattern = explicitPattern || (pos[0] ?? "");
	const rawPath = explicitPattern ? pos[0] : pos[1];
	const cleanPattern =
		rawPattern && !isNoiseTarget(rawPattern) && rawPattern.length <= 32 && !/[()[\]{}|]/.test(rawPattern)
			? rawPattern
			: "";
	let cleanPath = rawPath ? compactDisplayPath(rawPath, cwd) : dirHint;
	if (cleanPath && isNoiseTarget(cleanPath)) cleanPath = "";
	return [cleanPattern, cleanPath].filter(Boolean).join(" · ");
}

function extractPortOrPid(segment: string): string {
	const port = segment.match(/(?:-LocalPort|port\s+|[:=])\s*(\d{2,5})\b/i)?.[1];
	const pid = segment.match(/(?:-Id\s+|ProcessId=)(\d+)\b/i)?.[1];
	const parts: string[] = [];
	if (port) parts.push(`:${port}`);
	if (pid) parts.push(`PID ${pid}`);
	if (parts.length) return parts.join(" · ");
	const procName = segment.match(/(?:-Name\s+|--?process\s+)["']?([A-Za-z0-9._-]+)["']?/i)?.[1];
	return procName ?? "";
}

/**
 * 识别常见开发 / 诊断命令的语义意图与核心对象（纯文本、无语言依赖）。
 * 无法安全归类时返回 null，前端回退为常规的 `cleanCommand` 展示。
 */
function describeCommandIntentInner(command: string, cwd?: string, depth = 0): CommandIntent | null {
	const cleaned = cleanCommand(command, cwd);
	if (!cleaned.text) return null;
	const { dirHint, body } = peelLeadingCd(cleaned.text);
	const segments = splitTopLevel(body).map((s) => s.trim()).filter(Boolean);
	const primary = (segments[0] ?? body).replace(/^(?:\w+=\S*\s+)+/, "").trim();
	const withoutVarAssign = primary.replace(/^\$[A-Za-z_][A-Za-z0-9_]*\s*=\s*/, "").trim();
	const tokens = extractTokens(withoutVarAssign);
	const rawVerb = basename(tokens[0] ?? "").replace(/\.(exe|cmd|bat|ps1)$/i, "").toLowerCase();
	const sub = (tokens[1] ?? "").toLowerCase();
	const lower = body.toLowerCase();

	// 0. 剥开一层外壳封装命令（powershell -Command "..." / bash -lc "..." / cmd /c "..."）
	if (depth === 0 && (rawVerb === "powershell" || rawVerb === "pwsh" || rawVerb === "bash" || rawVerb === "sh" || rawVerb === "cmd")) {
		const flagIdx = tokens.findIndex((t, idx) => idx > 0 && /^-(?:command|c|lc)$/i.test(t) || t.toLowerCase() === "/c");
		const inner = flagIdx > 0 ? unquote(tokens.slice(flagIdx + 1).join(" ")) : "";
		if (inner) {
			const nested = describeCommandIntentInner(inner, cwd, 1);
			if (nested) return { ...nested, lines: cleaned.lines };
		}
	}

	// 1. 网络抓包 / 抓包工具检测
	if (
		rawVerb === "tshark" ||
		rawVerb === "dumpcap" ||
		rawVerb === "pktmon" ||
		rawVerb === "tcpdump" ||
		/\b(tshark|dumpcap|pktmon|tcpdump|scapy)\b/.test(lower)
	) {
		const foundTools = [...new Set(lower.match(/\b(tshark|dumpcap|pktmon|tcpdump|scapy)\b/g) ?? [])];
		const port = extractPortOrPid(body);
		const target = [foundTools.slice(0, 3).join(" / "), port].filter(Boolean).join(" · ");
		return { category: "net_capture", target: compactTarget(target || dirHint), lines: cleaned.lines };
	}

	// 2. 端口与进程探测
	if (
		rawVerb === "get-nettcpconnection" ||
		rawVerb === "get-process" ||
		rawVerb === "lsof" ||
		rawVerb === "ss" ||
		rawVerb === "netstat" ||
		rawVerb === "tasklist" ||
		rawVerb === "ps" ||
		rawVerb === "pgrep" ||
		(rawVerb === "get-ciminstance" && /win32_process/i.test(withoutVarAssign))
	) {
		return {
			category: "port_proc",
			target: compactTarget(extractPortOrPid(withoutVarAssign) || dirHint),
			lines: cleaned.lines,
		};
	}

	// 3. 测试 / 类型检查 / 打包构建
	if (
		rawVerb === "vitest" ||
		rawVerb === "pytest" ||
		rawVerb === "jest" ||
		rawVerb === "playwright" ||
		((rawVerb === "npx" || rawVerb === "pnpm" || rawVerb === "bunx") && /^(vitest|jest|playwright)$/.test(sub)) ||
		((rawVerb === "npm" || rawVerb === "pnpm" || rawVerb === "yarn" || rawVerb === "bun") && (sub === "test" || (sub === "run" && /^test(:|$)/.test(tokens[2]?.toLowerCase() ?? "")))) ||
		((rawVerb === "cargo" || rawVerb === "go") && sub === "test")
	) {
		const testFile = tokens.find((tok) => /\.(?:test|spec)\.[a-z]+$/i.test(unquote(tok)));
		const target = testFile ? relativizePath(unquote(testFile), cwd) : dirHint;
		return { category: "test_check", target: compactTarget(target), lines: cleaned.lines };
	}

	if (
		rawVerb === "tsc" ||
		rawVerb === "eslint" ||
		rawVerb === "pyright" ||
		rawVerb === "mypy" ||
		rawVerb === "ruff" ||
		((rawVerb === "npx" || rawVerb === "pnpm" || rawVerb === "bunx") && /^(tsc|eslint|pyright)$/.test(sub)) ||
		((rawVerb === "npm" || rawVerb === "pnpm" || rawVerb === "yarn") && sub === "run" && /^(typecheck|lint|check)$/.test(tokens[2]?.toLowerCase() ?? ""))
	) {
		return { category: "type_check", target: compactTarget(dirHint), lines: cleaned.lines };
	}

	if (
		((rawVerb === "npm" || rawVerb === "pnpm" || rawVerb === "yarn" || rawVerb === "bun") && (sub === "build" || (sub === "run" && /^build(:|$)/.test(tokens[2]?.toLowerCase() ?? "")))) ||
		((rawVerb === "next" || rawVerb === "vite" || rawVerb === "cargo" || rawVerb === "go") && sub === "build")
	) {
		return { category: "build", target: compactTarget(dirHint), lines: cleaned.lines };
	}

	// 4. Git 操作
	if (rawVerb === "git") {
		if (sub === "grep") {
			return { category: "code_search", target: compactTarget(extractSearchIntent(tokens.slice(2), cwd, dirHint)), lines: cleaned.lines };
		}
		if (GIT_HEAD_SUBS.has(sub) || sub === "rev-parse" || sub === "describe") {
			return { category: "git_inspect", target: compactTarget(withoutVarAssign), lines: cleaned.lines };
		}
		if (sub) {
			return { category: "git_write", target: compactTarget(withoutVarAssign), lines: cleaned.lines };
		}
	}

	// 5. Python / Node 内联或脚本执行
	if (rawVerb === "python" || rawVerb === "python3" || rawVerb === "py") {
		const pyFile = tokens.slice(1).find((tok) => /\.py$/i.test(unquote(tok)));
		const modIdx = tokens.findIndex((tok, i) => i > 0 && tok === "-m");
		const modName = modIdx > 0 ? tokens[modIdx + 1] : undefined;
		let target = pyFile ? compactDisplayPath(unquote(pyFile), cwd) : modName ? `-m ${modName}` : "";
		if (!target) {
			const hintFile = command.match(/([\w./-]+\.(?:py|db|sqlite|json|jsonl|log))\b/i)?.[1];
			const hintPort = command.match(/(?:127\.0\.0\.1|localhost):(\d{2,5})/i)?.[1];
			target = hintFile ? basename(hintFile) : hintPort ? `:${hintPort}` : dirHint;
		}
		return { category: "script_py", target: compactTarget(target), lines: cleaned.lines };
	}
	if (
		(rawVerb === "node" &&
			(sub === "-e" || sub === "--eval" || sub === "--input-type" || tokens.slice(1).some((tok) => /\.(?:m?js|cjs|tsx?)$/i.test(unquote(tok))))) ||
		rawVerb === "tsx"
	) {
		const jsFile = tokens.slice(1).find((tok) => /\.(?:m?js|cjs|tsx?)$/i.test(unquote(tok)));
		return { category: "script_node", target: compactTarget(jsFile ? compactDisplayPath(unquote(jsFile), cwd) : dirHint), lines: cleaned.lines };
	}

	// 6. SQLite 查询
	if (rawVerb === "sqlite3") {
		const dbFile = tokens.slice(1).find((tok) => !tok.startsWith("-"));
		return { category: "sqlite", target: compactTarget(dbFile ? relativizePath(unquote(dbFile), cwd) : dirHint), lines: cleaned.lines };
	}

	// 7. 代码 / 文本搜索
	if (rawVerb === "rg" || rawVerb === "grep" || rawVerb === "egrep" || rawVerb === "fgrep" || rawVerb === "ag" || rawVerb === "findstr" || rawVerb === "select-string" || rawVerb === "sls") {
		const target = extractSearchIntent(tokens.slice(1), cwd, dirHint);
		return { category: "code_search", target: compactTarget(target), lines: cleaned.lines };
	}

	// 8. 目录遍历与存在性探测
	if (
		rawVerb === "get-childitem" ||
		rawVerb === "gci" ||
		rawVerb === "test-path" ||
		rawVerb === "resolve-path" ||
		rawVerb === "ls" ||
		rawVerb === "dir" ||
		rawVerb === "tree" ||
		rawVerb === "find" ||
		rawVerb === "fd" ||
		/^for\s+\w+\s+in\b/i.test(withoutVarAssign)
	) {
		let paths = extractPathsFromArgs(withoutVarAssign, cwd);
		if (paths.length === 0 && /^for\s+\w+\s+in\b/i.test(withoutVarAssign)) {
			const inMatch = withoutVarAssign.match(/\bin\s+([^;]+)/i)?.[1] ?? "";
			paths = extractTokens(inMatch).map((tok) => normalizeShellPathToken(tok, cwd)).filter(Boolean).slice(0, 2);
		}
		if (paths.length === 0 && dirHint && !isNoiseTarget(dirHint)) paths = [dirHint];
		return { category: "dir_list", target: compactTarget(paths.join(" · ")), lines: cleaned.lines };
	}

	// 9. 文件读取与日志查看
	if (
		rawVerb === "cat" ||
		rawVerb === "head" ||
		rawVerb === "tail" ||
		rawVerb === "get-content" ||
		rawVerb === "gc" ||
		rawVerb === "get-item" ||
		rawVerb === "gi" ||
		rawVerb === "get-itemproperty" ||
		rawVerb === "type" ||
		rawVerb === "wc" ||
		rawVerb === "stat" ||
		rawVerb === "file" ||
		rawVerb === "nl" ||
		rawVerb === "sed" ||
		rawVerb === "jq"
	) {
		const paths = extractPathsFromArgs(withoutVarAssign, cwd);
		const safeDir = dirHint && !isNoiseTarget(dirHint) ? dirHint : "";
		const target = paths.length > 0 ? paths.join(" · ") : safeDir;
		return { category: "file_read", target: compactTarget(target), lines: cleaned.lines };
	}

	// 10. 网络请求与环境探测
	if (rawVerb === "curl" || rawVerb === "wget" || rawVerb === "invoke-webrequest" || rawVerb === "invoke-restmethod" || rawVerb === "iwr" || rawVerb === "irm") {
		const urlTok = tokens.find((tok) => /^https?:\/\//i.test(unquote(tok)));
		return { category: "http", target: compactTarget(urlTok ? unquote(urlTok) : dirHint), lines: cleaned.lines };
	}

	if (rawVerb === "which" || rawVerb === "where" || rawVerb === "get-command") {
		const cmds = tokens.slice(1).filter((tok) => !tok.startsWith("-") && !tok.startsWith("2>")).slice(0, 3);
		return { category: "env_probe", target: compactTarget(cmds.join(" / ") || dirHint), lines: cleaned.lines };
	}

	return null;
}

export function describeCommandIntent(command: string, cwd?: string): CommandIntent | null {
	return describeCommandIntentInner(command, cwd, 0);
}
