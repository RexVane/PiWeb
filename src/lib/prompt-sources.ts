/**
 * prompt-sources：集中列出所有承载提示词的来源，供界面上"点开即看"。
 *
 * 覆盖：系统提示词覆盖文件（SYSTEM.md）、追加提示词（APPEND_SYSTEM.md）、项目记忆（AGENTS.md）、
 * 技能提示词（SKILL.md）、提示模板（prompts/*.md）、以及来自扩展与 npm 包的同类资源；
 * 热会话还额外给出"组装后真正发给模型的系统提示词"和每个工具的定义（名称/描述/参数 schema）。
 *
 * 只读：不改动任何提示词内容，也不影响发给模型的东西。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { getAgentDir, getResourceLoader, refreshResourceLoaderIfStale } from "./pi";
import { BoundaryError, isPathInside, resolveDiscoveredPath, samePath } from "./path-security";
import { FileSizeLimitError, readFileBounded } from "./read-file-bounded";
import { PIWEB_EXECUTION_GUIDANCE } from "./execution-guidance";
import { ASK_USER_TOOL } from "./ask-user";
import { REQUEST_PERMISSION_TOOL } from "./permission-request";

export const MAX_PROMPT_SOURCE_BYTES = 1024 * 1024;

/** 提示词来源类别：界面按这个分组 */
export type PromptSourceKind = "system" | "append" | "agents" | "skill" | "template" | "tool" | "assembled";

/** 来源出处：界面据此显示徽标（项目 / 个人 / 某个包 / 某个扩展 / PiWeb 自有） */
export interface PromptSourceOrigin {
	scope: "project" | "agent" | "package" | "extension" | "piweb";
	/** scope 为 package/extension 时的名字 */
	name?: string;
}

export interface PromptSource {
	kind: PromptSourceKind;
	/** 展示名：文件名（不含目录）或工具名 */
	name: string;
	/** 绝对路径；合成项（assembled）和虚拟项（PiWeb 注入）没有路径 */
	path?: string;
	origin: PromptSourceOrigin;
	/** 文件字节数（有路径且能 stat 到时）或虚拟内容字节数 */
	bytes?: number;
	/** 虚拟来源的内容（无文件路径时直接携带） */
	content?: string;
}

export interface PromptToolView {
	name: string;
	description?: string;
	/** 参数 JSON schema，原样透出由界面格式化 */
	parameters?: unknown;
	promptGuidelines?: string[];
	source: "builtin" | "extension" | "piweb";
}

export interface PromptSourcesResult {
	sources: PromptSource[];
	/** 热会话才有：实际发给模型的完整系统提示词（含你的 AGENTS.md、技能段、工具清单与追加段——不做任何过滤） */
	assembledSystemPrompt?: string;
	/** 热会话才有：压缩摘要（compact 后进入上下文的历史摘要，平时在界面上看不见） */
	compactedSummary?: string;
	/** 热会话才有：每个工具的定义 */
	tools?: PromptToolView[];
	/** 冷会话（agent 未启动）时为 false，界面据此说明为什么缺少合成项 */
	sessionReady: boolean;
}

/** 只看这几个字段：够用且便于用假对象测试 */
export interface PromptSessionLike {
	systemPrompt: string;
	getAllTools(): Array<{
		name: string;
		description?: string;
		parameters?: unknown;
		promptGuidelines?: string[];
		sourceInfo?: { source?: string; origin?: string; scope?: string };
	}>;
	/** 会话条目入口：SDK 里字段名有 sm / sessionManager 两种（压缩摘要从这里取） */
	sm?: PromptSessionManagerLike;
	sessionManager?: PromptSessionManagerLike;
}

interface PromptSessionManagerLike {
	buildSessionProjection?: () => { messages: unknown[] };
	getBranch?: () => unknown[];
	getEntries?: () => unknown[];
}

interface SourceInfoLike {
	source?: string;
	scope?: string;
	origin?: string;
}

const normalize = (value: string) => value.replace(/\\/g, "/").toLowerCase();

/** 从 node_modules 路径里取包名（含 scope） */
function packageNameFromPath(filePath: string): string | undefined {
	const parts = filePath.replace(/\\/g, "/").split("/");
	const index = parts.lastIndexOf("node_modules");
	if (index < 0 || index + 1 >= parts.length) return undefined;
	const first = parts[index + 1];
	return first.startsWith("@") ? `${first}/${parts[index + 2] ?? ""}`.replace(/\/$/, "") : first;
}

/** 扩展目录名（<任意>/extensions/<name>/...） */
function extensionNameFromPath(filePath: string): string | undefined {
	const parts = filePath.replace(/\\/g, "/").split("/");
	const index = parts.lastIndexOf("extensions");
	if (index < 0 || index + 1 >= parts.length) return undefined;
	return parts[index + 1] || undefined;
}

/**
 * 判断一个提示词文件来自哪里。优先用 SDK 的 SourceInfo（有 scope/origin），
 * 没有时按路径归类：工作区内 = project，个人目录 = agent，node_modules = 某个包，
 * extensions 目录 = 某个扩展。
 */
export function classifyPromptOrigin(filePath: string, cwd: string, sourceInfo?: SourceInfoLike): PromptSourceOrigin {
	const normalized = normalize(filePath);
	const packageName = packageNameFromPath(filePath);
	if (packageName || sourceInfo?.origin === "package") {
		return { scope: "package", ...(packageName ?? sourceInfo?.source ? { name: packageName ?? sourceInfo?.source } : {}) };
	}
	const resolvedCwd = normalize(path.resolve(cwd));
	if (normalized === resolvedCwd || normalized.startsWith(`${resolvedCwd}/`)) return { scope: "project" };
	const agentDir = normalize(getAgentDir());
	if (normalized.startsWith(`${agentDir}/`)) {
		// 个人目录里的扩展也算扩展，便于区分"我自己装的那个扩展"
		const extension = extensionNameFromPath(filePath);
		return extension ? { scope: "extension", name: extension } : { scope: "agent" };
	}
	const extension = extensionNameFromPath(filePath);
	if (extension) return { scope: "extension", name: extension };
	if (sourceInfo?.scope === "project") return { scope: "project" };
	return { scope: "agent" };
}

const KIND_ORDER: PromptSourceKind[] = ["system", "append", "agents", "skill", "template", "tool", "assembled"];

/** 纯函数：把各来源整理成界面要的列表（按类别、再按名字排序） */
export function buildPromptSources(entries: Array<Omit<PromptSource, "origin"> & { origin?: PromptSourceOrigin; cwd: string; sourceInfo?: SourceInfoLike }>): PromptSource[] {
	return entries
		.map(({ cwd, sourceInfo, origin, ...rest }) => ({
			...rest,
			origin: origin ?? classifyPromptOrigin(rest.path ?? "", cwd, sourceInfo),
		}))
		.sort((a, b) => {
			const byKind = KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind);
			return byKind !== 0 ? byKind : a.name.localeCompare(b.name);
		});
}

async function fileSize(filePath: string | undefined): Promise<number | undefined> {
	if (!filePath) return undefined;
	try {
		const stat = await fs.stat(filePath);
		return stat.isFile() ? stat.size : undefined;
	} catch {
		return undefined;
	}
}

/** 当前模型上下文里的压缩摘要；其他分支的压缩记录不会进入这里。 */
export function latestCompactionSummary(session: PromptSessionLike): string | undefined {
	try {
		const manager = session.sm ?? session.sessionManager;
		if (manager?.buildSessionProjection) {
			const messages = manager.buildSessionProjection().messages;
			for (let i = messages.length - 1; i >= 0; i -= 1) {
				const message = messages[i] as { role?: string; summary?: string };
				if (message?.role === "compactionSummary" && typeof message.summary === "string" && message.summary.trim()) return message.summary;
			}
			return undefined;
		}
		const entries = manager?.getBranch?.() ?? manager?.getEntries?.() ?? [];
		for (let i = entries.length - 1; i >= 0; i -= 1) {
			const entry = entries[i] as { type?: string; summary?: string };
			if (entry?.type === "compaction" && typeof entry.summary === "string" && entry.summary.trim()) return entry.summary;
		}
	} catch {
		/* 条目不可用则跳过 */
	}
	return undefined;
}

/** 列出当前工作区的全部提示词来源（冷会话也能列全文件类来源） */
export async function listPromptSources({
	cwd,
	session,
}: {
	cwd: string;
	session?: PromptSessionLike | null;
}): Promise<PromptSourcesResult> {
	const resolvedCwd = path.resolve(cwd);
	await refreshResourceLoaderIfStale(resolvedCwd);
	const loader = getResourceLoader(resolvedCwd);

	const raw: Array<Omit<PromptSource, "origin"> & { cwd: string; sourceInfo?: SourceInfoLike; baseName?: string }> = [];
	const push = (kind: PromptSourceKind, filePath: string | undefined, name: string | undefined, sourceInfo?: SourceInfoLike) => {
		if (!filePath) return;
		raw.push({ kind, path: filePath, name: name || path.basename(filePath), cwd: resolvedCwd, ...(sourceInfo ? { sourceInfo } : {}) });
	};

	const systemSource = loader.getSystemPromptSource();
	push("system", systemSource?.path, systemSource ? path.basename(systemSource.path) : undefined);

	for (const source of loader.getAppendSystemPromptSources()) push("append", source.path, source ? path.basename(source.path) : undefined);
	for (const file of loader.getAgentsFiles().agentsFiles) push("agents", file.path, path.basename(file.path));
	for (const skill of loader.getSkills().skills) push("skill", skill.filePath, skill.name || path.basename(skill.filePath), skill.sourceInfo as SourceInfoLike | undefined);
	for (const template of loader.getPrompts().prompts) push("template", template.filePath, template.name || path.basename(template.filePath), template.sourceInfo as SourceInfoLike | undefined);

	const withSizes = await Promise.all(raw.map(async (entry) => ({ ...entry, bytes: await fileSize(entry.path) })));
	const sources = buildPromptSources(withSizes);

	// PiWeb 自有追加提示词：不是文件、没有路径，直接作为来源条目插入（标记 origin 为 piweb）
	const guidanceBytes = Buffer.byteLength(PIWEB_EXECUTION_GUIDANCE, "utf8");
	sources.push({ kind: "append", name: "PiWeb execution guidance", origin: { scope: "piweb" }, bytes: guidanceBytes, content: PIWEB_EXECUTION_GUIDANCE });

	// 压缩摘要：compact 之后它以摘要形式进入上下文，界面上平时看不到，这里一并列出
	const compacted = session ? latestCompactionSummary(session) : undefined;

	const piwebToolNames: ReadonlySet<string> = new Set([ASK_USER_TOOL, REQUEST_PERMISSION_TOOL]);
	const tools = session
		? session.getAllTools().map((tool) => ({
			name: tool.name,
			...(tool.description === undefined ? {} : { description: tool.description }),
			...(tool.parameters === undefined ? {} : { parameters: tool.parameters }),
			...(tool.promptGuidelines?.length ? { promptGuidelines: tool.promptGuidelines } : {}),
			source: piwebToolNames.has(tool.name) ? ("piweb" as const) : tool.sourceInfo?.source === "builtin" ? ("builtin" as const) : ("extension" as const),
		}))
		: undefined;

	return {
		sources,
		...(session?.systemPrompt ? { assembledSystemPrompt: session.systemPrompt } : {}),
		...(compacted ? { compactedSummary: compacted } : {}),
		...(tools ? { tools } : {}),
		sessionReady: Boolean(session),
	};
}

/** 来源正文及其附件共用发现边界；链接限于该技能目录或当前工作区，realpath 后再次验边界。 */
export async function resolvePromptSourcePath(filePath: string, cwd: string, sourcePath?: string): Promise<string> {
	const { sources } = await listPromptSources({ cwd });
	const allowed = sources.map((source) => source.path).filter((value): value is string => typeof value === "string");
	if (sourcePath === undefined) {
		return resolveDiscoveredPath(filePath, allowed);
	}
	const source = await resolveDiscoveredPath(sourcePath, allowed);
	if (typeof filePath !== "string" || !path.isAbsolute(filePath) || filePath.length > 4096) throw new BoundaryError("invalid resource path");
	const authorized = await fs.realpath(filePath).catch(() => { throw new BoundaryError("resource not found"); });
	const roots = [await fs.realpath(cwd)];
	for (const candidate of sources) {
		if (candidate.kind !== "skill" || !candidate.path) continue;
		const real = await fs.realpath(candidate.path).catch(() => null);
		if (real && samePath(real, source)) roots.push(path.dirname(real));
	}
	if (!roots.some((root) => isPathInside(root, authorized)) && !samePath(source, authorized)) {
		throw new BoundaryError("linked resource escapes the workspace or skill directory");
	}
	const stat = await fs.stat(authorized);
	if (!stat.isFile()) throw new BoundaryError("resource is not a file");
	return authorized;
}

export async function readPromptSource(filePath: string, cwd: string, sourcePath?: string): Promise<string> {
	const authorized = await resolvePromptSourcePath(filePath, cwd, sourcePath);
	try { return (await readFileBounded(authorized, MAX_PROMPT_SOURCE_BYTES)).toString("utf8"); }
	catch (error) {
		if (error instanceof FileSizeLimitError) throw new BoundaryError("prompt resource exceeds 1 MB");
		throw error;
	}
}
