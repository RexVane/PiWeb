/**
 * 思考档位探测：对 OpenAI 兼容（completions）端点逐档发送最小请求，回答三件事——
 * 1. 哪些档位值被端点接受（枚举校验，400 = 不认这个值）；
 * 2. 档位是否真的改变思考量（同题各档采样比 reasoning tokens）；
 * 3. 端点是否在多个上游之间轮询（响应 id 形态 + 回显 model 组成指纹，指纹多于一种 =
 *    同一参数会落到不同后端，档位语义不可靠——中转站常见）。
 *
 * 只诊断，不替用户拍板：结果连同建议的 thinkingLevelMap 一起给 UI，由用户确认后才写入。
 * 纯函数部分（指纹、分析、校验）不引入 node 专用模块，客户端测试可直接导入。
 */
import { THINKING_LEVELS } from "./thinking-level";

/** 探测用的档位值：off 在请求里对应 "none"（pi-ai 通用 openai 分支的 off 缺省值） */
export const PROBE_OFF_VALUE = "none";
/** 除 off 外参与枚举探测的档位（顺序即 THINKING_LEVELS） */
export const PROBE_LEVEL_VALUES = THINKING_LEVELS.filter((level) => level !== "off");
/** 行为采样只挑中间三档，控制请求次数（部分中转限速 20 次/分钟） */
const BEHAVIOR_LEVELS = ["low", "medium", "high"] as const;
const ACCEPTANCE_MAX_TOKENS = 16;
const BEHAVIOR_MAX_TOKENS = 2000;
const BEHAVIOR_PROMPT =
	"A train travels 120 km at 80 km/h, then 90 km at 45 km/h, waits 15 minutes, then returns the whole way at 100 km/h. What is the average speed for the entire round trip including the wait? Show every step, then give the final number.";

export interface ThinkingProbeAttempt {
	/** "absent" = 不带 reasoning_effort 的基线；其余为 pi 档位名 */
	level: string;
	/** control = 控制请求；acceptance = 枚举探测；behavior = 行为采样（UI 只把 behavior 列进样本表） */
	phase: "control" | "acceptance" | "behavior";
	ok: boolean;
	status?: number;
	reasoningTokens: number | null;
	completionTokens: number | null;
	/** 响应指纹：id 形态 + 回显 model（空 = 响应里没有可用信息） */
	backend: string;
	latencyMs: number;
	error?: string;
}

export interface ThinkingProbeReport {
	/** pi 档位 → 端点是否接受该值（"off" 探测的是 "none"） */
	accepted: Record<string, boolean>;
	attempts: ThinkingProbeAttempt[];
	/** 出现过的后端指纹（去重） */
	backends: string[];
	/** 同一批请求命中多个上游 → 档位语义不可靠 */
	multiUpstream: boolean;
	verdict: "rejected" | "unstable" | "effective" | "inconclusive";
	/** 建议写入 models.json 的 thinkingLevelMap；null = 不建议写入 */
	suggestedMap: Record<string, string | null> | null;
	notes: string[];
}

/** 单次请求的结果压缩成一条 attempt（不丢网络错误信息） */
interface RawAttempt {
	ok: boolean;
	status?: number;
	id?: string;
	modelEcho?: string;
	usage?: unknown;
	error?: string;
}

// ---------- 纯函数（可直接单测） ----------

/** usage.completion_tokens_details.reasoning_tokens（OpenAI 兼容口径；没有就 null） */
export function parseReasoningTokens(usage: unknown): number | null {
	if (usage === null || typeof usage !== "object" || Array.isArray(usage)) return null;
	const details = (usage as Record<string, unknown>).completion_tokens_details;
	if (details === null || typeof details !== "object" || Array.isArray(details)) return null;
	const value = (details as Record<string, unknown>).reasoning_tokens;
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** usage.completion_tokens */
export function parseCompletionTokens(usage: unknown): number | null {
	if (usage === null || typeof usage !== "object" || Array.isArray(usage)) return null;
	const value = (usage as Record<string, unknown>).completion_tokens;
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * 响应指纹：id 前缀形态 + 回显的 model。同一参数下指纹多于一种，
 * 就是网关在多个上游间轮询（实测中转站会出现 hex / uuid / chatcmpl 三种形态）。
 */
export function responseFingerprint(id: unknown, modelEcho: unknown): string {
	const raw = typeof id === "string" && id.trim() ? id.trim() : "";
	const model = typeof modelEcho === "string" && modelEcho.trim() ? modelEcho.trim() : "";
	const shape = !raw ? "unknown"
		: /^chatcmpl-/.test(raw) ? "chatcmpl"
		: /^resp_[0-9a-f]{16,}$/i.test(raw) ? "resp-hex"
		: /^resp_/.test(raw) ? "resp-uuid"
		: "other";
	return `${shape} · ${model || "?"}`;
}

/** pi-ai getSupportedThinkingLevels 的镜像：给 UI 显示「当前 N 档」用，避免引 pi-ai 进客户端包 */
export function supportedThinkingLevelsOf(reasoning: boolean, map: Record<string, string | null> | undefined): string[] {
	if (!reasoning) return ["off"];
	return THINKING_LEVELS.filter((level) => {
		const mapped = map?.[level];
		if (mapped === null) return false;
		if (level === "xhigh" || level === "max") return mapped !== undefined;
		return true;
	});
}

/**
 * 校验并规范化 thinkingLevelMap：键必须是 pi 档位（多余键一律拒绝，不给「顺手清配置」留口子），
 * 值是 1–64 个字符的字符串或 null。返回规范化后的表；不合法返回 null。
 */
export function validateThinkingLevelMap(value: unknown): Record<string, string | null> | null {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
	const source = value as Record<string, unknown>;
	const out: Record<string, string | null> = {};
	for (const level of THINKING_LEVELS) {
		if (!Object.prototype.hasOwnProperty.call(source, level)) continue;
		const entry = source[level];
		if (entry === null) { out[level] = null; continue; }
		if (typeof entry !== "string") return null;
		const trimmed = entry.trim();
		if (!trimmed || trimmed.length > 64 || /[\u0000-\u001f\u007f]/.test(trimmed)) return null;
		out[level] = trimmed;
	}
	for (const key of Object.keys(source)) if (!(THINKING_LEVELS as readonly string[]).includes(key)) return null;
	return out;
}

/** 建议的 thinkingLevelMap：接受的档位映射到自身，拒绝的置 null（= 在 UI 里隐藏该档） */
export function suggestLevelMap(accepted: Record<string, boolean>): Record<string, string | null> {
	const map: Record<string, string | null> = {};
	for (const level of THINKING_LEVELS) {
		if (level === "off") { map.off = accepted.off ? PROBE_OFF_VALUE : null; continue; }
		map[level] = accepted[level] ? level : null;
	}
	return map;
}

function behaviorMeans(attempts: ReadonlyArray<ThinkingProbeAttempt>): Map<string, number> {
	const sums = new Map<string, { total: number; n: number }>();
	for (const attempt of attempts) {
		if (attempt.level === "absent" || !attempt.ok || attempt.reasoningTokens === null) continue;
		const entry = sums.get(attempt.level) ?? { total: 0, n: 0 };
		entry.total += attempt.reasoningTokens;
		entry.n += 1;
		sums.set(attempt.level, entry);
	}
	const means = new Map<string, number>();
	for (const [level, { total, n }] of sums) means.set(level, total / n);
	return means;
}

/**
 * 从采样结果推断结论。规则（宁缺勿滥）：
 * - 全部档位值被拒 → rejected：端点根本不收 reasoning_effort，写映射也救不了；
 * - 指纹多于一种 → unstable：同参数落在不同后端，档位语义不可靠（给映射但必须警示）；
 * - low ≤ medium ≤ high 且 high > low → effective：档位确实控制思考量；
 * - 其余（思考量不随档位变、端点不报 reasoning tokens、样本不足）→ inconclusive。
 */
export function analyzeThinkingProbe(attempts: ReadonlyArray<ThinkingProbeAttempt>, accepted: Record<string, boolean>): Pick<ThinkingProbeReport, "backends" | "multiUpstream" | "verdict" | "suggestedMap" | "notes"> {
	const notes: string[] = [];
	const backends = [...new Set(attempts.map((attempt) => attempt.backend).filter(Boolean))];
	const multiUpstream = backends.length > 1;
	const anyAccepted = Object.values(accepted).some(Boolean);
	const rateLimited = attempts.some((attempt) => attempt.status === 429);
	if (rateLimited) notes.push("探测期间触发限速（429），样本可能不完整，结论仅供参考。");

	if (!anyAccepted) {
		notes.push("端点不接受 reasoning_effort 的任何取值（部分网关只认 thinking: {type} 等其他参数形态）。");
		return { backends, multiUpstream, verdict: "rejected", suggestedMap: null, notes };
	}

	const suggestedMap = suggestLevelMap(accepted);
	if (multiUpstream) {
		notes.push(`同一批请求命中 ${backends.length} 个不同的后端指纹（${backends.join(" / ")}）：该端点在多个上游之间轮询，档位与思考量没有稳定关系。建议改用直连端点，或接受映射但固定使用其中一档。`);
		return { backends, multiUpstream, verdict: "unstable", suggestedMap, notes };
	}

	const means = behaviorMeans(attempts);
	const levels = BEHAVIOR_LEVELS.filter((level) => means.has(level));
	if (levels.length < 2) {
		notes.push("可比较的档位样本不足（部分请求失败、被限速，或端点不报告 reasoning tokens），无法判断档位是否生效。");
		return { backends, multiUpstream, verdict: "inconclusive", suggestedMap, notes };
	}
	const values = levels.map((level) => means.get(level)!);
	const nonDecreasing = values.every((value, index) => index === 0 || value >= values[index - 1] - 1);
	const increases = values[values.length - 1] > values[0];
	if (nonDecreasing && increases) {
		notes.push("思考量随档位单调增加，档位在该端点上有效。");
		return { backends, multiUpstream, verdict: "effective", suggestedMap, notes };
	}
	notes.push("各档位的思考量没有单调关系（同档波动或档位间持平），参数被接受但未见稳定效果；建议只启用低档（low）试用，或改用直连端点。");
	return { backends, multiUpstream, verdict: "inconclusive", suggestedMap, notes };
}

// ---------- 实际探测（服务端调用） ----------

export interface ThinkingProbeOptions {
	baseUrl: string;
	modelId: string;
	headers?: Record<string, string>;
	/** 每档行为采样次数（默认 2） */
	samples?: number;
	/** 请求间隔，默认 1100ms（部分中转 20 次/分钟限速） */
	paceMs?: number;
	fetchImpl?: typeof fetch;
	signal?: AbortSignal;
}

const delay = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
	if (signal?.aborted) { reject(new Error("Request was aborted")); return; }
	const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
	const onAbort = () => { clearTimeout(timer); reject(new Error("Request was aborted")); };
	signal?.addEventListener("abort", onAbort, { once: true });
});

async function completionsCall(options: ThinkingProbeOptions, body: Record<string, unknown>, effort?: string): Promise<RawAttempt> {
	const headers = { "Content-Type": "application/json", Accept: "application/json", ...(options.headers ?? {}) };
	const payload: Record<string, unknown> = { ...body, ...(effort === undefined ? {} : { reasoning_effort: effort }) };
	try {
		const fetchImpl = options.fetchImpl ?? fetch;
		const response = await fetchImpl(`${options.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
			method: "POST",
			headers,
			body: JSON.stringify(payload),
			cache: "no-store",
			signal: AbortSignal.any([AbortSignal.timeout(30_000), ...(options.signal ? [options.signal] : [])]),
		});
		const text = await response.text();
		let parsed: Record<string, unknown> | null = null;
		try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { /* 非 JSON 响应按无指纹处理 */ }
		const usage = parsed?.usage;
		const choice = parsed && Array.isArray(parsed.choices) ? (parsed.choices[0] as Record<string, unknown> | undefined) : undefined;
		const id = typeof parsed?.id === "string" ? parsed.id : undefined;
		const modelEcho = typeof parsed?.model === "string" ? parsed.model : undefined;
		return {
			ok: response.ok,
			status: response.status,
			id,
			modelEcho,
			usage,
			...(!response.ok && !choice ? { error: `HTTP ${response.status}` } : {}),
		};
	} catch (error) {
		if (options.signal?.aborted) throw error;
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

function attemptOf(level: string, phase: ThinkingProbeAttempt["phase"], raw: RawAttempt, startedAt: number, behavior: boolean): ThinkingProbeAttempt {
	return {
		level,
		phase,
		ok: raw.ok,
		...(raw.status !== undefined ? { status: raw.status } : {}),
		reasoningTokens: raw.ok && behavior ? parseReasoningTokens(raw.usage) : null,
		completionTokens: raw.ok && behavior ? parseCompletionTokens(raw.usage) : null,
		backend: raw.ok ? responseFingerprint(raw.id, raw.modelEcho) : "",
		latencyMs: Date.now() - startedAt,
		...(raw.error ? { error: raw.error } : {}),
	};
}

/**
 * 执行一次完整探测（约 10–20 个请求，1–2 分钟）：
 * ① 控制请求（不带 reasoning_effort）：连不上 / 连请求形状都拒绝时直接抛错，别让用户白等一串 4xx；
 * ② 枚举探测：七个档位值各一个 max_tokens=16 的最小请求；
 * ③ 行为采样：absent 基线 + low/medium/high（被接受的）各 samples 次，比 reasoning tokens。
 */
export async function probeThinkingLevels(options: ThinkingProbeOptions): Promise<ThinkingProbeReport> {
	if (!options.baseUrl?.trim() || !options.modelId?.trim()) throw new Error("探测需要 baseUrl 和模型 ID");
	const samples = Math.max(1, Math.min(3, options.samples ?? 2));
	const paceMs = Math.max(0, options.paceMs ?? 1100);

	const attempts: ThinkingProbeAttempt[] = [];
	const accepted: Record<string, boolean> = {};

	const probeBody = { model: options.modelId, messages: [{ role: "user", content: "hi" }], max_tokens: ACCEPTANCE_MAX_TOKENS, temperature: 0 };
	// ① 控制请求
	const controlStarted = Date.now();
	const control = await completionsCall(options, probeBody);
	if (!control.ok) throw new Error(`端点拒绝了探测请求（${control.status !== undefined ? `HTTP ${control.status}` : control.error ?? "网络错误"}）：无法判断档位行为。`);
	attempts.push(attemptOf("absent", "control", control, controlStarted, false));

	// ② 枚举探测
	const acceptanceValues: Array<{ level: string; value: string }> = [
		{ level: "off", value: PROBE_OFF_VALUE },
		...PROBE_LEVEL_VALUES.map((level) => ({ level, value: level })),
	];
	for (const { level, value } of acceptanceValues) {
		await delay(paceMs, options.signal);
		const startedAt = Date.now();
		const raw = await completionsCall(options, probeBody, value);
		accepted[level] = raw.ok;
		attempts.push(attemptOf(level, "acceptance", raw, startedAt, false));
	}

	// ③ 行为采样（只在有档位被接受时才有意义）
	const behaviorBody = { model: options.modelId, messages: [{ role: "user", content: BEHAVIOR_PROMPT }], max_tokens: BEHAVIOR_MAX_TOKENS, temperature: 0 };
	const behaviorLevels = BEHAVIOR_LEVELS.filter((level) => accepted[level]);
	if (behaviorLevels.length) {
		for (let i = 0; i < samples; i += 1) {
			const startedAt = Date.now();
			const raw = await completionsCall(options, behaviorBody);
			attempts.push(attemptOf("absent", "behavior", raw, startedAt, true));
			for (const level of behaviorLevels) {
				await delay(paceMs, options.signal);
				const started = Date.now();
				const attempt = await completionsCall(options, behaviorBody, level);
				attempts.push(attemptOf(level, "behavior", attempt, started, true));
			}
		}
	}

	const analysis = analyzeThinkingProbe(attempts, accepted);
	return { accepted, attempts, ...analysis };
}
