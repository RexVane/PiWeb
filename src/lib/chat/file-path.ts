/**
 * 正文里的文件路径识别（纯函数）。
 *
 * 模型回答里经常出现 `src/lib/pi.ts`、`./scripts/dev.mjs` 这类路径，把它们变成可点击的、
 * 直接用 PiWeb 的文件查看器打开，省掉手动去项目栏里翻。
 *
 * 判定刻意保守——宁可少认，也不要把普通文字变成链接（猜错会让用户点开一个「文件不存在」）：
 *   - 必须有路径分隔符，或看起来像「名字.扩展名」；
 *   - 排除 URL（http/https/协议相对）、邮箱、纯版本号（v1.2.3 / 1.2.3）、纯数字；
 *   - 排除以 / 或 ~ 开头的绝对路径与家目录路径：它们不属于当前工作区，点开多半是错的；
 *   - 排除含空格、通配符、模板占位（< > { } * ?）的片段。
 *
 * 只做识别，不校验存在性：校验要为每个候选发一次请求，代价远大于收益；
 * 查看器本身对不存在的路径会体面地报错（见 FileViewer 的目录兜底与「文件不存在」）。
 */

/** 有扩展名的相对路径：至少一段目录 + 文件名.扩展名，如 src/lib/pi.ts、scripts/dev.mjs。
 *  目录段允许方括号——Next.js 的动态路由目录就是 [id] 这种写法，在 PiWeb 自己的代码里很常见。 */
const RELATIVE_WITH_DIR = /^(?:\.{1,2}\/)?(?:[\w.@[\]-]+\/)+[\w.@[\]-]+\.[A-Za-z][\w]{0,9}$/;
/** 只有文件名但带扩展名：如 agents.md、vite.config.ts、package.json —— 需要能对上常见代码/文档扩展名 */
const BARE_FILENAME = /^[\w.@-]+\.[A-Za-z][\w]{0,9}$/;
/**
 * 裸文件名允许的扩展名。这里刻意收窄：像 v1.2.3、1.24 这类「数字.数字」在形状上与
 * 文件名无法区分，靠扩展名列表把它们挡掉。
 */
const BARE_EXTENSIONS = new Set([
	"ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts",
	"json", "jsonc", "json5", "yml", "yaml", "toml", "ini", "env",
	"css", "scss", "sass", "less", "html", "htm", "vue", "svelte",
	"md", "mdx", "txt", "rst", "adoc",
	"py", "rb", "go", "rs", "java", "kt", "kts", "swift", "c", "h", "cc", "cpp", "hpp", "cs", "php", "lua", "sh", "bash", "zsh", "ps1", "psm1", "bat", "cmd",
	"sql", "graphql", "gql", "proto", "lock", "patch", "diff", "csv", "tsv", "xml", "svg",
]);
/** 明确不是路径的：URL、邮箱、协议相对地址 */
const NOT_A_PATH = /^(?:[a-z][a-z0-9+.-]*:\/\/|\/\/|mailto:|www\.)/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** 纯版本号：v1、1.2、v1.2.3、1.2.3-beta.1 */
const VERSION = /^v?\d+(?:\.\d+)*(?:[-+][\w.]+)?$/;

/** 单个片段是否像项目内的相对文件路径 */
export function looksLikeFilePath(raw: string): boolean {
	const value = raw.trim();
	if (!value || value.length > 260) return false;
	if (NOT_A_PATH.test(value) || EMAIL.test(value) || VERSION.test(value)) return false;
	// 绝对路径与家目录路径不属于当前工作区，点开多半是错的
	if (value.startsWith("/") || value.startsWith("~") || /^[A-Za-z]:[\\/]/.test(value)) return false;
	// 通配符 / 模板占位 / 反斜杠（Windows 路径在回答里少见，且与转义混淆）。
	// 方括号不在此列：Next.js 的动态路由目录（[id]）是合法目录名，见上面对 RELATIVE_WITH_DIR 的说明。
	if (/[*?<>{}|\\]/.test(value)) return false;
	if (RELATIVE_WITH_DIR.test(value)) return true;
	if (!BARE_FILENAME.test(value)) return false;
	const ext = value.slice(value.lastIndexOf(".") + 1).toLowerCase();
	return BARE_EXTENSIONS.has(ext);
}
