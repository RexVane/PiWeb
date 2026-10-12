/**
 * 思考档位的纯函数，客户端与服务端共用（不引入 pi-ai）。规则与 pi-ai 的 clampThinkingLevel、
 * pi 的 createAgentSession 一致；tests/thinking-level.test.ts 里逐项和 pi-ai 对照。
 */

/** pi-ai 的 EXTENDED_THINKING_LEVELS：从低到高 */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** pi 的 DEFAULT_THINKING_LEVEL：设置里没有默认档位、模型也没有覆盖时用它 */
export const DEFAULT_THINKING_LEVEL = "medium";

/**
 * 把档位钳到模型支持的范围：支持就原样返回；否则先向更高的档位找，再向更低的档位找，都没有就取第一个支持的。
 */
export function clampThinkingLevelTo(supported: readonly string[], level: string): string {
	if (supported.includes(level)) return level;
	const index = THINKING_LEVELS.indexOf(level);
	if (index === -1) return supported[0] ?? "off";
	for (let i = index; i < THINKING_LEVELS.length; i += 1) {
		if (supported.includes(THINKING_LEVELS[i])) return THINKING_LEVELS[i];
	}
	for (let i = index - 1; i >= 0; i -= 1) {
		if (supported.includes(THINKING_LEVELS[i])) return THINKING_LEVELS[i];
	}
	return supported[0] ?? "off";
}

/**
 * 新会话实际会用的档位（SDK createAgentSession 的规则）：用户显式选过就用它；否则依次取该模型的每模型覆盖、
 * 设置里的默认档位、DEFAULT_THINKING_LEVEL；最后按模型能力钳制。
 */
export function newSessionThinkingLevel(input: {
	supported: readonly string[];
	requested?: string;
	modelOverride?: string;
	defaultLevel?: string;
}): string {
	return clampThinkingLevelTo(input.supported, input.requested || input.modelOverride || input.defaultLevel || DEFAULT_THINKING_LEVEL);
}
