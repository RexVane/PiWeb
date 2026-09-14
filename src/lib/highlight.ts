/**
 * 代码高亮（highlight.js/lib/common，约 40 种常用语言）：文件面板预览、过程里的 diff、Git 面板共用。
 * 按 VS Code 的 token 粒度着色（关键字/字符串/数字/函数/类型/属性/标签/正则/元信息/标点），
 * 配色是 Pi 自己的：见 globals.css 的 --hl-* 变量（浅色 / 深色各一套）。
 */
import hljs from "highlight.js/lib/common";

const EXT_LANG: Record<string, string> = {
	ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
	js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
	json: "json", jsonc: "json", css: "css", scss: "scss", less: "less",
	html: "xml", htm: "xml", xml: "xml", svg: "xml", vue: "xml",
	md: "markdown", mdx: "markdown", py: "python", rb: "ruby", go: "go", rs: "rust",
	java: "java", kt: "kotlin", c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp", cs: "csharp",
	sh: "bash", bash: "bash", zsh: "bash", ps1: "powershell", psm1: "powershell",
	yml: "yaml", yaml: "yaml", toml: "ini", ini: "ini", cfg: "ini", env: "ini",
	sql: "sql", php: "php", swift: "swift", lua: "lua", r: "r", pl: "perl", diff: "diff", patch: "diff", makefile: "makefile",
};

/** 超过这个大小不做整文件高亮（highlight.js 是同步的，会卡主线程） */
export const HIGHLIGHT_MAX = 120 * 1024;

export function extOf(name: string): string {
	const base = name.replace(/\\/g, "/").split("/").pop() ?? name;
	const lower = base.toLowerCase();
	if (lower === "makefile") return "makefile";
	if (lower === "dockerfile") return "dockerfile";
	const i = lower.lastIndexOf(".");
	return i >= 0 ? lower.slice(i + 1) : "";
}

/** 按文件名给 highlight.js 的语言 id；认不出或未打包的语言返回 undefined */
export function languageForPath(path: string | undefined | null): string | undefined {
	if (!path) return undefined;
	const lang = EXT_LANG[extOf(path)];
	return lang && hljs.getLanguage(lang) ? lang : undefined;
}

/** 整段高亮，返回 HTML（highlight.js 已转义）；失败或过大返回 null */
export function highlightCode(content: string, language: string | undefined): string | null {
	if (content.length > HIGHLIGHT_MAX) return null;
	try {
		if (language && hljs.getLanguage(language)) return hljs.highlight(content, { language, ignoreIllegals: true }).value;
		if (content.length < 30 * 1024) return hljs.highlightAuto(content).value;
	} catch {
		/* fall through */
	}
	return null;
}

/** 单行高亮（diff 逐行用；跨行的注释/字符串会失去上下文，但足够看） */
export function highlightLine(text: string, language: string): string | null {
	if (!text || text.length > 2000) return null;
	try {
		return hljs.highlight(text, { language, ignoreIllegals: true }).value;
	} catch {
		return null;
	}
}
