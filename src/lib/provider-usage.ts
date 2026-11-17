/**
 * 提供商用量的纯类型与纯函数（客户端安全）。
 *
 * 这份文件绝不能引入 SDK 或任何 Node 专用模块：设置面板（客户端组件）按值导入
 * `quotaWindowKind` / `supportsUsageProbe`，一旦这里带上 SDK，webpack 会把
 * `fs` / `child_process` 打进浏览器 bundle，生产构建直接失败（踩过）。
 * 探测逻辑与缓存留在 models-service（服务端）。
 */

/** 一个用量窗口：窗口长度、剩余百分比、下次重置时刻（缺省表示服务端未给）。 */
export interface QuotaWindow {
	/** 窗口时长；服务端不暴露周期时缺省，界面就只显示剩余与重置，不编造周期。 */
	limitWindowSeconds?: number;
	remainingPercent: number;
	resetAt?: string;
	/** 同类周期的窗口需要互相区分时使用（如 Claude 的 Opus/Sonnet 专用周限、Kimi 的月度代码额度）。 */
	variant?: string;
	/** 没有固定周期或特定用途的窗口名（如 rolling、Copilot 类别、Codex 代码审查、Z.AI MCP 工具）。 */
	name?: string;
	/** 服务端明确返回了精确计数（如 Copilot 次数或 Z.AI token/次配额）时才填，不做猜测。 */
	used?: number;
	limit?: number;
	remaining?: number;
	overagePermitted?: boolean;
}

/** 订阅附带的按量超额额度（Claude extra_usage）或附加积分池（Codex credits）。 */
export interface QuotaExtraUsage {
	kind: "extra" | "credits";
	used?: BalanceAmount;
	limit?: BalanceAmount;
	balance?: BalanceAmount;
	remainingPercent?: number;
	unlimited?: boolean;
	limitReached?: boolean;
}

/** 窗口制订阅额度（Codex / Claude / Kimi Code / Copilot / OpenCode Go / Z.AI）：按窗口给出剩余百分比与重置时刻。 */
export interface QuotaUsage {
	kind: "quota";
	planType?: string;
	/** 账户实际给出的全部窗口，按时长升序。 */
	windows: QuotaWindow[];
	limitReached?: boolean;
	extra?: QuotaExtraUsage;
	probedAt: number;
}

/** 余额明细项的语义，标签由界面翻译，服务端只给 key。 */
export type BalanceDetailKey = "granted" | "toppedUp" | "voucher" | "cash" | "used" | "limit";
export type BalanceSpendPeriod = "daily" | "weekly" | "monthly";

export interface BalanceAmount {
	amount: string;
	currency?: string;
}

/** 金额制余额（DeepSeek / OpenRouter / Moonshot / Vercel AI Gateway）：一个主余额加若干明细。 */
export interface BalanceUsage {
	kind: "balance";
	/** 主余额的语义；默认按「剩余额度」渲染。 */
	primaryKey?: "remaining" | BalanceDetailKey;
	primary?: BalanceAmount;
	details: Array<{ key: BalanceDetailKey } & BalanceAmount>;
	/** DeepSeek 等接口明确声明当前额度是否可用；未返回则不显示状态牌。 */
	available?: boolean;
	/** OpenRouter 免费层级标识。 */
	isFreeTier?: boolean;
	/** OpenRouter 日/周/月实时消耗（服务端有返回时附带）。 */
	periodSpend?: Array<{ period: BalanceSpendPeriod } & BalanceAmount>;
	probedAt: number;
}

/** xAI 订阅配额（响应头 x-ratelimit-*，需要一次可能计费的请求）。 */
export interface XaiUsage {
	kind: "xai";
	model: string;
	requestLimit: number;
	requestRemaining: number;
	tokenLimit: number;
	tokenRemaining: number;
	probedAt: number;
}

export type ProviderUsage = XaiUsage | QuotaUsage | BalanceUsage;

export const WEEKLY_WINDOW_SECONDS = 7 * 24 * 60 * 60;
export const MONTHLY_WINDOW_SECONDS = 30 * 24 * 60 * 60;

/** 窗口时长归类，供界面选标签：7 天即常说的「周限」，30 天为月限，更短的按小时/天。 */
export type QuotaWindowKind = "weekly" | "monthly" | "hours" | "days";

export function quotaWindowKind(seconds: number): QuotaWindowKind {
	if (seconds === WEEKLY_WINDOW_SECONDS) return "weekly";
	if (seconds === MONTHLY_WINDOW_SECONDS) return "monthly";
	return seconds < 24 * 60 * 60 ? "hours" : "days";
}

/** 提供只读用量端点的提供商（models-service 的 usageProbeFor 按同一份名单分派）。 */
export const USAGE_PROBE_PROVIDER_IDS = [
	"xai",
	"openai-codex",
	"anthropic",
	"deepseek",
	"openrouter",
	"moonshotai",
	"moonshotai-cn",
	"kimi-coding",
	"github-copilot",
	"vercel-ai-gateway",
	"opencode-go",
	"zai",
	"zai-coding-cn",
] as const;

export function supportsUsageProbe(providerId: string): boolean {
	return (USAGE_PROBE_PROVIDER_IDS as readonly string[]).includes(providerId);
}
