const ICON_RULES: Array<[RegExp, string]> = [
	[/^amazon-bedrock$/, "bedrock-color"],
	[/^ant-ling$/, "antgroup-color"],
	[/^anthropic$/, "anthropic"],
	[/^azure-/, "azure-color"],
	[/^baseten$/, "baseten"],
	[/^cerebras$/, "cerebras-color"],
	[/^cloudflare-/, "cloudflare-color"],
	[/^deepseek$/, "deepseek-color"],
	[/^fireworks$/, "fireworks-color"],
	[/^github-copilot$/, "githubcopilot"],
	[/^google-vertex(?:-|$)/, "googlecloud-color"],
	[/^google$/, "google-color"],
	[/^groq$/, "groq"],
	[/^huggingface$/, "huggingface-color"],
	[/^kimi(?:-|$)/, "kimi-color"],
	[/^minimax/, "minimax-color"],
	[/^mistral$/, "mistral-color"],
	[/^moonshot(?:ai)?(?:-|$)/, "moonshot"],
	[/^nvidia$/, "nvidia-color"],
	[/^openai/, "openai"],
	[/^opencode(?:-|$)/, "opencode"],
	[/^openrouter$/, "openrouter-color"],
	[/^qwen(?:-|$)/, "qwen-color"],
	[/^together$/, "together-color"],
	[/^vercel(?:-|$)/, "vercel"],
	[/^xai$/, "xai"],
	[/^xiaomi(?:-|$)/, "xiaomimimo"],
	[/^zai(?:-|$)/, "zai"],
];

export const PROVIDER_ICON_SLUGS = [...new Set(ICON_RULES.map(([, slug]) => slug))];

export function providerIconSlug(providerId: string): string | null {
	return ICON_RULES.find(([pattern]) => pattern.test(providerId))?.[1] ?? null;
}

export function providerInitials(name: string, providerId: string): string {
	const words = name.trim().split(/[\s_-]+/).filter(Boolean);
	if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
	return (words[0] ?? providerId).slice(0, 2).toUpperCase();
}

export const CUSTOM_PROVIDER_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export const FALLBACK_CUSTOM_APIS = [
	"openai-completions",
	"openai-responses",
	"anthropic-messages",
	"google-generative-ai",
] as const;

export function customApiOptions(providerApis: string[]): string[] {
	const fallback = new Set<string>(FALLBACK_CUSTOM_APIS);
	const discovered = [...new Set(providerApis.filter((api) => api && !fallback.has(api)))].sort();
	return [...FALLBACK_CUSTOM_APIS, ...discovered];
}
