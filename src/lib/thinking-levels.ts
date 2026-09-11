/**
 * 思考级别：与 pi-ai `getSupportedThinkingLevels` / `clampThinkingLevel` 完全一致的实现。
 * pi-ai 是 pi-coding-agent 的嵌套依赖，PiWeb 无法直接 import，因此在这里复刻同一算法，
 * 保证新会话页 / 预设 / 冷会话快照给出的档位与 AgentSession 运行时一致。
 */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevelName = (typeof THINKING_LEVELS)[number];

interface ModelLike {
	reasoning?: boolean;
	thinkingLevelMap?: Partial<Record<string, string | null>> | null;
}

/** 模型支持的档位：非推理模型只有 off；map 为 null 的档位排除；xhigh/max 必须显式映射才可用 */
export function supportedThinkingLevels(model: ModelLike | null | undefined): ThinkingLevelName[] {
	if (!model || model.reasoning !== true) return ["off"];
	const map = model.thinkingLevelMap ?? undefined;
	return THINKING_LEVELS.filter((level) => {
		const mapped = map?.[level];
		if (mapped === null) return false;
		if (level === "xhigh" || level === "max") return mapped !== undefined;
		return true;
	});
}

/** 就近钳制：先向上找可用档位，再向下找，都没有取第一个 */
export function clampThinkingLevel(model: ModelLike | null | undefined, level: string): ThinkingLevelName {
	const available = supportedThinkingLevels(model);
	if (available.includes(level as ThinkingLevelName)) return level as ThinkingLevelName;
	const requested = THINKING_LEVELS.indexOf(level as ThinkingLevelName);
	if (requested === -1) return available[0] ?? "off";
	for (let i = requested; i < THINKING_LEVELS.length; i += 1) if (available.includes(THINKING_LEVELS[i])) return THINKING_LEVELS[i];
	for (let i = requested - 1; i >= 0; i -= 1) if (available.includes(THINKING_LEVELS[i])) return THINKING_LEVELS[i];
	return available[0] ?? "off";
}
