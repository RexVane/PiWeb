/**
 * 子进程环境清洗。
 *
 * PiWeb 自己启动的子进程（git、编辑器、安装器…）默认继承整个 Web 进程环境，
 * 其中可能有启动令牌、provider API key、代理口令等只属于 PiWeb 进程的凭据。
 * 这里提供统一入口：默认剥掉名字像凭据的变量，需要时用 allowlist 显式放回，
 * 再用 extra 把子进程真正需要的值补上。
 *
 * 刻意保持同步、纯函数：调用方拿到的是一份新对象，直接传给 spawn/execFile 的 env，
 * 不需要 cwd 等其它参数（工作目录、PATH 解析仍由调用方自己决定）。
 */

/** 名字命中这些片段的变量默认不进子进程（大小写不敏感）。 */
const SENSITIVE_NAME_PATTERN = /TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|CREDENTIAL|PRIVATE[_-]?(?:KEY|TOKEN)?/i;

/**
 * 即使名字命中敏感模式也保留的例外：常见的是代理类变量（HTTP_PROXY 里的口令
 * 属于子进程正常联网所需）以及 SSH agent（git 推送要用）。
 */
const DEFAULT_ALLOWLIST = [
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"ALL_PROXY",
	"NO_PROXY",
	"http_proxy",
	"https_proxy",
	"all_proxy",
	"no_proxy",
	"SSH_AUTH_SOCK",
] as const;

/** git 按仓库/会话注入的变量：子进程继承它们会把 git 指到别的仓库或索引上。 */
const GIT_SESSION_VARIABLES = [
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_INDEX_FILE",
	"GIT_OBJECT_DIRECTORY",
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_NAMESPACE",
	"GIT_COMMON_DIR",
	"GIT_CONFIG",
	"GIT_CONFIG_COUNT",
	"GIT_CONFIG_KEY_0",
	"GIT_CONFIG_VALUE_0",
	"GIT_PREFIX",
	"GIT_IMPLICIT_WORK_TREE",
	"GIT_GRAFT_FILE",
	"GIT_SHALLOW_FILE",
	"GIT_REPLACE_REF_BASE",
] as const;

export interface ScrubbedEnvOptions {
	/**
	 * 追加“即使命中敏感模式也保留”的变量名（大小写不敏感）。
	 * 比如某个子进程确实需要 MY_SERVICE_TOKEN，就把它列在这里。
	 */
	allowlist?: readonly string[];
	/** 清洗后再合并的变量：子进程专用值、或需要覆盖的普通变量。 */
	extra?: Record<string, string | undefined>;
	/** 额外按名字移除的变量（大小写不敏感，直接比较全名）。 */
	denylist?: readonly string[];
	/** 是否移除 NODE_OPTIONS / NODE_PATH 这类进程注入变量，默认移除。 */
	stripNodeInjection?: boolean;
}

function sensitiveName(name: string, allowlist: ReadonlySet<string>): boolean {
	const key = name.toLowerCase();
	if (allowlist.has(key)) return false;
	return SENSITIVE_NAME_PATTERN.test(name);
}

/**
 * 返回一份可安全交给子进程的环境变量副本。
 *
 * - 默认：保留 base 里除“名字像凭据”之外的变量（PATH/HOME/USERPROFILE/APPDATA 等自然保留）；
 * - 敏感名字：含 TOKEN/SECRET/PASSWORD/PASSWD/API_KEY/CREDENTIAL/PRIVATE 的变量被移除；
 * - allowlist：命名的变量即使像凭据也保留；默认已包含代理变量与 SSH_AUTH_SOCK；
 * - extra：清洗后合并，优先级最高（可以补回确实需要的值）；
 * - stripNodeInjection（默认 true）：移除 NODE_OPTIONS/NODE_PATH，防止子进程继承注入。
 */
export function scrubbedEnv(
	base: Record<string, string | undefined> = process.env,
	options: ScrubbedEnvOptions = {},
): NodeJS.ProcessEnv {
	const allowlist = new Set<string>(
		[...DEFAULT_ALLOWLIST, ...(options.allowlist ?? [])].map((name) => name.toLowerCase()),
	);
	const denylist = new Set((options.denylist ?? []).map((name) => name.toLowerCase()));
	const stripNodeInjection = options.stripNodeInjection !== false;
	const result: Record<string, string> = {};
	for (const [name, value] of Object.entries(base)) {
		if (typeof value !== "string") continue;
		const lower = name.toLowerCase();
		if (denylist.has(lower)) continue;
		if (stripNodeInjection && (lower === "node_options" || lower === "node_path")) continue;
		if (sensitiveName(name, allowlist)) continue;
		result[name] = value;
	}
	for (const [name, value] of Object.entries(options.extra ?? {})) {
		if (typeof value === "string") result[name] = value;
	}
	// Next 的全局类型把 NODE_ENV 标成 ProcessEnv 的必填项；env 只是字符串映射，按约定返回。
	return result as NodeJS.ProcessEnv;
}

/** 编辑器/原生打开场景的别名：不需要把 PATH、DISPLAY、VISUAL 之类过滤掉，只要去掉凭据。 */
export function editorEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
	return scrubbedEnv(process.env, { extra: overrides });
}

/** 通用便捷别名：给任意子进程用，等价于 scrubbedEnv(process.env, { extra: overrides })。 */
export function childProcessEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
	return scrubbedEnv(process.env, { extra: overrides });
}

/**
 * git 子进程环境：在 scrubbedEnv 基础上移除继承的 GIT_* 会话变量，
 * 避免仓库里的配置/父进程把 git 指到别的目录或索引。
 */
export function gitEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
	return scrubbedEnv(process.env, { denylist: GIT_SESSION_VARIABLES, extra: overrides });
}
