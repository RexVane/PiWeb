/**
 * 新会话页的默认模型与思考档位：照 pi CLI 选初始模型的规则（SDK 的 findInitialModel 没有导出，这里照着做）。
 * 顺序：enabledModels 第一个 → 设置里的默认模型（且有凭证）→ 已知 provider 的默认模型表 → 第一个可用模型。
 * CLI 参数与会话恢复不适用于 Web 的新会话。
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import { resolveModelScopeWithDiagnostics } from "@earendil-works/pi-coding-agent";
import type { ModelScopeRuntime } from "./models/model-scope";
import { getModelRuntime, getSettingsManager } from "./pi";

/**
 * pi 的 defaultModelPerProvider（SDK 未导出，照抄）。键的顺序就是 pi 的查找顺序。
 * 测试会和已安装 SDK 的源码对表，SDK 升级后表对不上会直接报出来。
 */
export const DEFAULT_MODEL_PER_PROVIDER: Readonly<Record<string, string>> = {
	"amazon-bedrock": "us.anthropic.claude-opus-4-6-v1",
	"ant-ling": "Ring-2.6-1T",
	anthropic: "claude-opus-4-8",
	openai: "gpt-5.5",
	azure: "gpt-5.4",
	"openai-codex": "gpt-6.1-sol",
	radius: "balanced",
	nvidia: "nvidia/nemotron-3-ultra-550b-a55b",
	deepseek: "deepseek-v4-pro",
	google: "gemini-3.1-pro-preview",
	"google-vertex": "gemini-3.1-pro-preview",
	"github-copilot": "gpt-5.4",
	openrouter: "moonshotai/kimi-k2.6",
	"vercel-ai-gateway": "zai/glm-5.1",
	xai: "grok-4.7",
	groq: "openai/gpt-oss-120b",
	cerebras: "gpt-oss-120b",
	zai: "glm-5.3",
	"zai-coding-cn": "glm-5.3",
	mistral: "devstral-medium-latest",
	minimax: "MiniMax-M2.7",
	"minimax-cn": "MiniMax-M2.7",
	moonshotai: "kimi-k2.6",
	"moonshotai-cn": "kimi-k2.6",
	huggingface: "moonshotai/Kimi-K2.6",
	fireworks: "accounts/fireworks/models/kimi-k3",
	together: "moonshotai/Kimi-K3",
	baseten: "zai-org/GLM-5.2",
	opencode: "kimi-k2.6",
	"opencode-go": "kimi-k3",
	"kimi-coding": "kimi-for-coding",
	meta: "muse-spark-1.3",
	"cloudflare-workers-ai": "@cf/moonshotai/kimi-k2.6",
	"cloudflare-ai-gateway": "workers-ai/@cf/moonshotai/kimi-k2.6",
	"qwen-token-plan": "qwen3.7-max",
	"qwen-token-plan-cn": "qwen3.7-max",
	"qwen-token-plan-individual": "qwen3.8-max",
	xiaomi: "mimo-v2.5-pro",
	"xiaomi-token-plan-cn": "mimo-v2.5-pro",
	"xiaomi-token-plan-ams": "mimo-v2.5-pro",
	"xiaomi-token-plan-sgp": "mimo-v2.5-pro",
};

export interface InitialModelInput {
	/** settings 的 enabledModels（模式串）；空数组表示不限定范围 */
	patterns: string[];
	defaultProvider?: string;
	defaultModelId?: string;
}

/** pi 新会话的初始模型（findInitialModel 的第 2–4 步） */
export async function pickInitialModel(runtime: ModelScopeRuntime, input: InitialModelInput): Promise<Model<Api> | undefined> {
	if (input.patterns.length > 0) {
		const { scopedModels } = await resolveModelScopeWithDiagnostics(input.patterns, runtime);
		if (scopedModels.length > 0) return scopedModels[0].model;
	}
	if (input.defaultProvider && input.defaultModelId) {
		const configured = runtime.getModel(input.defaultProvider, input.defaultModelId);
		if (configured && runtime.hasConfiguredAuth(configured.provider)) return configured;
	}
	const available = runtime.getAvailableSnapshot();
	for (const [provider, modelId] of Object.entries(DEFAULT_MODEL_PER_PROVIDER)) {
		const match = available.find((model) => model.provider === provider && model.id === modelId);
		if (match) return match;
	}
	return available[0];
}

export interface NewSessionDefaults {
	model?: { provider: string; id: string };
	/** settings.json 的 defaultThinkingLevel */
	defaultThinkingLevel?: string;
	/** settings.json 的 modelThinkingLevels，键为 provider/modelId */
	modelThinkingLevels: Record<string, string>;
}

/** 新会话页要的：建议的初始模型，以及它会用到的思考档位设置（按工作区读 pi 的设置） */
export async function newSessionDefaults(cwd: string): Promise<NewSessionDefaults> {
	const settings = getSettingsManager(cwd);
	const model = await pickInitialModel(await getModelRuntime(), {
		patterns: settings.getEnabledModels() ?? [],
		defaultProvider: settings.getDefaultProvider(),
		defaultModelId: settings.getDefaultModel(),
	});
	return {
		model: model ? { provider: model.provider, id: model.id } : undefined,
		defaultThinkingLevel: settings.getDefaultThinkingLevel(),
		modelThinkingLevels: settings.getAllModelThinkingLevels(),
	};
}
