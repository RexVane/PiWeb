/**
 * models-service：pi 模型目录 / 认证状态 / API key 管理 / 自定义 provider（models.json）。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { getAgentDir, getModelRuntime, resetModelRuntime } from "./pi";

export interface ModelView {
	provider: string;
	id: string;
	name: string;
	reasoning: boolean;
	thinkingLevels: string[];
	contextWindow: number;
	input: string[];
	cost: { input: number; output: number } | null;
}

export interface ProviderView {
	id: string;
	name: string;
	authConfigured: boolean;
	authSource?: string;
	keyManaged: boolean;
	modelCount: number;
}

const LEVEL_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** 模型支持的思考级别：reasoning=false → 仅 off；thinkingLevelMap 有键 → 取非 null 键；否则全档 */
function modelThinkingLevels(mm: any): string[] {
	if (mm.reasoning !== true) return ["off"];
	const map = mm.thinkingLevelMap as Partial<Record<string, string | null>> | undefined;
	let levels = LEVEL_ORDER.slice(1);
	if (map && typeof map === "object") {
		const keys = Object.keys(map).filter((k) => map[k] !== null);
		if (keys.length) levels = keys;
	}
	return ["off", ...levels.filter((l) => LEVEL_ORDER.includes(l))].filter((l, i, arr) => arr.indexOf(l) === i).sort((a, b) => LEVEL_ORDER.indexOf(a) - LEVEL_ORDER.indexOf(b));
}

function envKeyOf(providerId: string): string | null {
	void providerId;
	return null;
}

export async function listModels(): Promise<{
	providers: ProviderView[];
	models: ModelView[];
}> {
	const rt = await getModelRuntime();
	const providers = rt.getProviders();
	const out: ProviderView[] = [];
	const models: ModelView[] = [];
	for (const p of providers as any[]) {
		const pid = String(p.id ?? p.name ?? "");
		if (!pid) continue;
		let auth: any = null;
		try {
			auth = rt.getProviderAuthStatus(pid);
		} catch {
			auth = null;
		}
		const list = rt.getModels(pid) as any[];
		out.push({
			id: pid,
			name: String(p.name ?? pid),
			authConfigured: auth?.configured === true,
			authSource: auth?.source,
			keyManaged: auth?.source === "stored",
			modelCount: list.length,
		});
		for (const mm of list) {
			models.push({
				provider: pid,
				id: String(mm.id),
				name: String(mm.name ?? mm.id),
				reasoning: mm.reasoning === true,
			thinkingLevels: modelThinkingLevels(mm),
				contextWindow: Number(mm.contextWindow ?? 0),
				input: Array.isArray(mm.input) ? mm.input.map(String) : ["text"],
				cost: mm.cost ? { input: mm.cost.input, output: mm.cost.output } : null,
			});
		}
	}
	models.sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id));
	return { providers: out, models };
}

/** 录入 / 更新 API key（写 ~/.pi/agent/auth.json，与终端 pi 共享） */
export async function setApiKey(providerId: string, apiKey: string): Promise<void> {
	const rt = await getModelRuntime();
	await rt.login(providerId, "api_key", {
		prompt: async () => apiKey,
		notify: () => {},
	} as never);
}

export async function removeApiKey(providerId: string): Promise<void> {
	const rt = await getModelRuntime();
	await rt.logout(providerId);
}

// ---------- OAuth 订阅登录（Claude/Codex/Copilot 等） ----------

interface PendingLogin {
	providerId: string;
	prompt: any | null;
	resolver: ((value: string) => void) | null;
	rejecter: ((err: Error) => void) | null;
	notifyLog: string[];
	done: boolean;
	error?: string;
}

const pendingLogins = new Map<string, PendingLogin>();

/** 启动 OAuth 登录（后台运行，交互经 pendingLogin 桥接到浏览器轮询） */
export async function startLogin(providerId: string): Promise<void> {
	// 已有同 provider 流程则先取消
	const prev = pendingLogins.get(providerId);
	if (prev && !prev.done) prev.rejecter?.(new Error("canceled"));
	const pl: PendingLogin = { providerId, prompt: null, resolver: null, rejecter: null, notifyLog: [], done: false };
	pendingLogins.set(providerId, pl);
	const rt = await getModelRuntime();
	void rt
		.login(providerId, "oauth", {
			prompt: async (p: any) => {
				pl.prompt = p;
				const answer = await new Promise<string>((resolve, reject) => {
					pl.resolver = resolve;
					pl.rejecter = reject;
				});
				pl.prompt = null;
				return answer;
			},
			notify: (e: any) => {
				pl.notifyLog.push(typeof e === "string" ? e : JSON.stringify(e));
				if (pl.notifyLog.length > 20) pl.notifyLog.shift();
			},
		} as never)
		.then(() => {
			pl.done = true;
			pl.prompt = null;
		})
		.catch((err: any) => {
			pl.done = true;
			pl.error = String(err?.message ?? err);
			pl.prompt = null;
		});
}

export function loginState(providerId: string): {
	prompt: { type: string; message: string; placeholder?: string; options?: string[] } | null;
	notifyLog: string[];
	done: boolean;
	error?: string;
} {
	const pl = pendingLogins.get(providerId);
	if (!pl) return { prompt: null, notifyLog: [], done: true };
	return {
		prompt: pl.prompt
			? {
					type: String(pl.prompt.type ?? "text"),
					message: String(pl.prompt.message ?? ""),
					placeholder: pl.prompt.placeholder ? String(pl.prompt.placeholder) : undefined,
					options: Array.isArray(pl.prompt.options) ? pl.prompt.options.map((o: any) => String(o.label ?? o.value ?? o)) : undefined,
				}
			: null,
		notifyLog: [...pl.notifyLog],
		done: pl.done,
		error: pl.error,
	};
}

export function answerLogin(providerId: string, text: string): boolean {
	const pl = pendingLogins.get(providerId);
	if (!pl?.resolver) return false;
	pl.resolver(text);
	return true;
}

export function cancelLogin(providerId: string): boolean {
	const pl = pendingLogins.get(providerId);
	if (!pl) return false;
	pl.rejecter?.(new Error("canceled"));
	return true;
}

// ---------- 自定义 provider（~/.pi/agent/models.json） ----------

function modelsJsonPath(): string {
	return path.join(getAgentDir(), "models.json");
}

export async function readCustomProviders(): Promise<{ content: string; exists: boolean }> {
	try {
		return { content: await fs.readFile(modelsJsonPath(), "utf8"), exists: true };
	} catch {
		return { content: JSON.stringify({ providers: {} }, null, 2), exists: false };
	}
}

export async function writeCustomProviders(content: string): Promise<void> {
	const parsed = JSON.parse(content) as { providers?: Record<string, unknown> };
	if (!parsed || typeof parsed !== "object" || typeof parsed.providers !== "object" || parsed.providers === null) {
		throw new Error('models.json 顶层必须是 { "providers": { ... } }');
	}
	for (const [id, p] of Object.entries(parsed.providers)) {
		if (!p || typeof p !== "object") throw new Error(`provider "${id}" 必须是对象`);
		const provider = p as Record<string, unknown>;
		if (typeof provider.baseUrl !== "string" || !provider.baseUrl) throw new Error(`provider "${id}" 缺少 baseUrl`);
		if (typeof provider.api !== "string" || !provider.api)
			throw new Error(`provider "${id}" 缺少 api（openai-completions / openai-responses / anthropic-messages / google-generative-ai）`);
		if (!Array.isArray(provider.models)) throw new Error(`provider "${id}" 缺少 models 数组`);
	}
	await fs.writeFile(modelsJsonPath(), JSON.stringify(parsed, null, 2), "utf8");
	resetModelRuntime();
}
