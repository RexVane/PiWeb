/**
 * 全站数字显示格式。
 *
 * 精度口径（用户要求「精确到小数点后两位」）：
 * - 比率（缓存命中 / 上下文占用）、速率（tok/s）、秒级时长：一律两位小数；
 * - token 量：≥1000 用 K、≥100 万用 M，都两位小数；<1000 原样整数（计数没有小数含义）；
 * - 轮次 / 步数 / 文件数等计数：整数；
 * - 分钟级时长保持 `19m30s`（`19m30.42s` 更难读）、金额保持四位（`$0.0123` 是惯例）。
 *
 * 以前 ChatWindow / ContextMeter / TrajectoryView 各有一份 fmtTok，同一个数字在三处
 * 显示不同（262400 → `262K` / `262.4K` / `262.4K`；53000000 → `53M` / `53000.0K` / `53.0M`），
 * 统一到这里。
 */

/** token 量：K / M 两位小数，<1000 整数 */
export function fmtTokens(value: number): string {
	if (!Number.isFinite(value)) return "—";
	if (Math.abs(value) < 1_000) return String(Math.round(value));
	// 先按 K 缩放；四舍五入到两位小数后已到 1000.00K 就升级成 M，避免出现「1000.00K」
	const k = value / 1_000;
	if (Math.abs(Number(k.toFixed(2))) < 1_000) return `${k.toFixed(2)}K`;
	return `${(value / 1_000_000).toFixed(2)}M`;
}

/** 计数（轮次 / 步数 / 文件数）：整数 */
export function fmtCount(value: number): string {
	return Number.isFinite(value) ? String(Math.round(value)) : "—";
}

/** 百分比：入参是 0–100 的数值，输出两位小数 */
export function fmtPercent(percent: number): string {
	return `${(Number.isFinite(percent) ? percent : 0).toFixed(2)}%`;
}

/** 速率：tok/s，两位小数 */
export function fmtThroughput(tokensPerSecond: number): string {
	return (Number.isFinite(tokensPerSecond) ? tokensPerSecond : 0).toFixed(2);
}

/**
 * 时长：不足 60 秒两位小数（`5.32s`），到分钟级用 `19m30s`（秒级再补小数只会更难读）。
 */
export function fmtDuration(ms: number): string {
	const seconds = Math.max(0, Number.isFinite(ms) ? ms : 0) / 1_000;
	if (seconds < 60) return `${seconds.toFixed(2)}s`;
	const whole = Math.round(seconds);
	return `${Math.floor(whole / 60)}m${whole % 60}s`;
}

/** 文件大小：B 整数，KB / MB 两位小数 */
export function fmtBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
	if (bytes < 1_024) return `${Math.round(bytes)} B`;
	if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(2)} KB`;
	return `${(bytes / 1_024 / 1_024).toFixed(2)} MB`;
}
