"use client";
/**
 * 提示词面板：把"发给模型的提示词从哪来"集中列出来，点某一项查看原文。
 *
 * 只读：文件类来源的路径来自 Pi 资源加载器（项目记忆 / 系统提示词覆盖 / 追加提示词 /
 * 技能 / 提示模板，含扩展与 npm 包提供的那些）；热会话额外给出"组装后的系统提示词"
 * 与每个工具的定义，它们不是文件、没有路径，直接在本面板内展开查看。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/i18n";
import { IconRefreshOutline14, IconCloseOutline14 } from "@/components/icons";

export type PromptSourceKind = "system" | "append" | "agents" | "skill" | "template" | "tool" | "assembled";

export interface PromptSourceOrigin {
	scope: "project" | "agent" | "package" | "extension";
	name?: string;
}

export interface PromptSource {
	kind: PromptSourceKind;
	name: string;
	path?: string;
	origin: PromptSourceOrigin;
	bytes?: number;
}

export interface PromptToolView {
	name: string;
	description?: string;
	parameters?: unknown;
	promptGuidelines?: string[];
	source: "builtin" | "extension";
}

export interface PromptSourcesData {
	sources: PromptSource[];
	assembledSystemPrompt?: string;
	/** 压缩摘要（同样进入上下文） */
	compactedSummary?: string;
	tools?: PromptToolView[];
	sessionReady: boolean;
}

const GROUP_KINDS: PromptSourceKind[] = ["system", "append", "agents", "skill", "template", "tool", "assembled"];

function formatBytes(bytes: number | undefined): string {
	if (!bytes) return "";
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function PromptPanel({
	cwd,
	sessionId,
	refreshKey,
	onOpenContent,
	onClose,
}: {
	cwd: string;
	sessionId: string | null;
	/** 变化即重新拉取（例如切换会话） */
	refreshKey?: string | number | null;
	/** 打开查看器显示内容（复用应用现有的文件查看器） */
	onOpenContent?: (path: string, content: string) => void;
	onClose: () => void;
}) {
	const { t } = useI18n();
	const owner = JSON.stringify([cwd, sessionId]);
	const [catalog, setCatalog] = useState<{ owner: string; data: PromptSourcesData } | null>(null);
	const data = catalog?.owner === owner ? catalog.data : null;
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [opening, setOpening] = useState<string | null>(null);
	const listRequest = useRef<AbortController | null>(null);
	const readRequest = useRef<AbortController | null>(null);

	const load = useCallback(async () => {
		listRequest.current?.abort();
		readRequest.current?.abort();
		const controller = new AbortController();
		listRequest.current = controller;
		const current = () => listRequest.current === controller && !controller.signal.aborted;
		setCatalog(null);
		setOpening(null);
		setBusy(true);
		setError(null);
		try {
			const query = new URLSearchParams({ cwd });
			if (sessionId) query.set("session", sessionId);
			const response = await fetch(`/api/prompts?${query.toString()}`, { signal: controller.signal });
			const body = await response.json();
			if (!current()) return;
			if (!response.ok || !body.success) throw new Error(body.error || `request failed (${response.status})`);
			setCatalog({ owner, data: body.data as PromptSourcesData });
		} catch (err) {
			if (current()) setError(err instanceof Error ? err.message : String(err));
		} finally {
			if (current()) setBusy(false);
		}
	}, [cwd, sessionId, owner]);

	useEffect(() => {
		void load();
		return () => {
			listRequest.current?.abort();
			readRequest.current?.abort();
		};
	}, [load, refreshKey]);

	const originLabel = (origin: PromptSourceOrigin): string => {
		if (origin.scope === "project") return t.promptOriginProject;
		if (origin.scope === "agent") return t.promptOriginAgent;
		if (origin.scope === "package") return `${t.promptOriginPackage} ${origin.name ?? ""}`.trim();
		return `${t.promptOriginExtension} ${origin.name ?? ""}`.trim();
	};

	const kindLabel = (kind: PromptSourceKind): string => {
		switch (kind) {
			case "system": return t.promptKindSystem;
			case "append": return t.promptKindAppend;
			case "agents": return t.promptKindAgents;
			case "skill": return t.promptKindSkill;
			case "template": return t.promptKindTemplate;
			case "tool": return t.promptKindTool;
			case "assembled": return t.promptKindAssembled;
		}
	};

	/** 文件类：按需读内容，交给外部查看器 */
	const openFile = async (source: PromptSource) => {
		if (!source.path || !onOpenContent) return;
		readRequest.current?.abort();
		const controller = new AbortController();
		const catalogRequest = listRequest.current;
		readRequest.current = controller;
		const current = () => readRequest.current === controller && !controller.signal.aborted && listRequest.current === catalogRequest;
		setOpening(source.path);
		setError(null);
		try {
			const response = await fetch("/api/prompts", {
				method: "POST",
				signal: controller.signal,
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ action: "read", filePath: source.path, cwd }),
			});
			const body = await response.json();
			if (!current()) return;
			if (!response.ok || !body.success) throw new Error(body.error || "read failed");
			onOpenContent(source.path, body.data.content as string);
		} catch (err) {
			if (current()) setError(err instanceof Error ? err.message : String(err));
		} finally {
			if (current()) setOpening(null);
		}
	};

	const groups = GROUP_KINDS.map((kind) => ({ kind, items: (data?.sources ?? []).filter((source) => source.kind === kind) })).filter(
		(group) => group.items.length > 0,
	);
	const hasTools = (data?.tools?.length ?? 0) > 0;

	const fileExtBadge = (name: string): string => {
		const ext = name.split(".").pop()?.toUpperCase() ?? "DOC";
		return ext.length <= 4 ? ext : "DOC";
	};

	return (
		<div className="flex min-h-0 flex-1 flex-col p-2 select-none">
			{/* Right Header (Screen 2 Claymorphism) */}
			<div className="flex items-center justify-between pb-3 mb-3 border-b border-slate-200 dark:border-slate-800 px-2">
				<div className="flex items-center gap-2">
					<div className="w-2.5 h-2.5 rounded-full bg-sky-500 animate-pulse" />
					<h2 className="text-sm font-bold text-slate-900 dark:text-slate-100 tracking-tight">{t.promptPanel}</h2>
				</div>
				<div className="flex items-center gap-1.5 text-slate-500">
					<button
						type="button"
						className="w-7 h-7 clay-btn bg-white dark:bg-slate-800 text-slate-700 hover:text-slate-950 dark:text-slate-300 dark:hover:text-white transition-colors shadow-sm"
						title={t.promptRefresh}
						aria-label={t.promptRefresh}
						onClick={() => void load()}
					>
						<span className={busy ? "piweb-spin" : undefined} style={{ display: "inline-flex" }}>
							<IconRefreshOutline14 size={13} />
						</span>
					</button>
					<button
						type="button"
						className="w-7 h-7 clay-btn bg-white dark:bg-slate-800 text-slate-700 hover:text-rose-600 dark:text-slate-300 transition-colors shadow-sm"
						title={t.close}
						aria-label={t.close}
						onClick={onClose}
					>
						<IconCloseOutline14 size={13} />
					</button>
				</div>
			</div>

			<div className="min-h-0 flex-1 overflow-y-auto px-1 space-y-4 text-xs">
				{error && (
					<div className="rounded-xl px-3 py-2 bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300 font-semibold" role="alert">
						{error}
					</div>
				)}

				{!data && busy && <div className="text-slate-500 py-4 text-center">{t.promptLoading}</div>}

				{data && !data.sessionReady && (
					<div className="rounded-xl px-3 py-2.5 clay-inset text-slate-600 dark:text-slate-300 leading-relaxed text-xs" role="status">
						{t.promptColdHint}
					</div>
				)}

				{groups.map((group) => (
					<section key={group.kind} className="space-y-1.5">
						<div className="flex items-center justify-between text-xs font-bold text-slate-800 dark:text-slate-200 px-1 mb-1">
							<span>{kindLabel(group.kind)}</span>
							<span className="text-[10px] text-slate-500 dark:text-slate-400 font-mono font-semibold">{group.items.length} 项</span>
						</div>
						<div className="flex flex-col gap-1.5">
							{group.items.map((source) => (
								<button
									key={`${source.kind}:${source.path ?? source.name}`}
									type="button"
									className={`clay-card p-3 flex items-center justify-between hover:scale-[1.01] transition-all cursor-pointer rounded-2xl text-left bg-white dark:bg-slate-900 shadow-sm border border-slate-200 dark:border-slate-800 ${
										opening === source.path ? "ring-2 ring-emerald-500" : ""
									}`}
									title={source.path ?? source.name}
									onClick={() => void openFile(source)}
								>
									<div className="flex items-center gap-2.5 min-w-0 flex-1 mr-2">
										<div className="w-7 h-7 clay-inset bg-emerald-50 text-emerald-700 dark:bg-emerald-950/70 dark:text-emerald-300 flex items-center justify-center rounded-xl font-mono font-bold text-[10px] flex-none">
											{fileExtBadge(source.name)}
										</div>
										<div className="min-w-0 flex-1">
											<div className="text-xs font-bold text-slate-900 dark:text-slate-100 truncate">{source.name}</div>
											<div className="text-[11px] text-slate-600 dark:text-slate-400 truncate">{source.path ?? kindLabel(source.kind)}</div>
										</div>
									</div>
									<div className="text-right flex-none flex flex-col items-end gap-0.5">
										{source.bytes !== undefined && (
											<span className="text-[11px] font-mono font-bold text-slate-800 dark:text-slate-200 block">
												{formatBytes(source.bytes)}
											</span>
										)}
										<span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 font-semibold border border-slate-200 dark:border-slate-700">
											{originLabel(source.origin)}
										</span>
									</div>
								</button>
							))}
						</div>
					</section>
				))}

				{hasTools && (
					<section className="space-y-1.5">
						<div className="flex items-center justify-between text-xs font-bold text-slate-800 dark:text-slate-200 px-1 mb-1">
							<span>{t.promptKindTool}</span>
							<span className="text-[10px] text-slate-500 dark:text-slate-400 font-mono font-semibold">{data!.tools!.length} 个工具</span>
						</div>
						<div className="flex flex-col gap-1.5">
							{data!.tools!.map((tool) => (
								<button
									key={`tool:${tool.name}`}
									type="button"
									className="clay-card p-3 flex items-center justify-between hover:scale-[1.01] transition-all cursor-pointer rounded-2xl text-left bg-white dark:bg-slate-900 shadow-sm border border-slate-200 dark:border-slate-800"
									title={tool.name}
									onClick={() =>
										onOpenContent?.(
											`tool-${tool.name}.md`,
											[
												`# ${tool.name}`,
												tool.source === "builtin" ? t.promptToolBuiltin : t.promptToolExtension,
												tool.description ?? "",
												...(tool.promptGuidelines?.length ? [t.promptGuidelines, ...tool.promptGuidelines.map((line) => `- ${line}`)] : []),
												...(tool.parameters ? [t.promptParameters, "```json", JSON.stringify(tool.parameters, null, 2), "```"] : []),
											]
												.filter(Boolean)
												.join("\n\n"),
										)
									}
								>
									<div className="flex items-center gap-2.5 min-w-0 flex-1 mr-2">
										<div className="w-7 h-7 clay-inset bg-sky-50 text-sky-700 dark:bg-sky-950/70 dark:text-sky-300 flex items-center justify-center rounded-xl font-mono font-bold text-[10px] flex-none">
											TOOL
										</div>
										<div className="min-w-0 flex-1">
											<div className="text-xs font-bold text-slate-900 dark:text-slate-100 truncate">{tool.name}</div>
											<div className="text-[11px] text-slate-600 dark:text-slate-400 truncate">{tool.description || t.promptKindTool}</div>
										</div>
									</div>
									<span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 font-semibold border border-slate-200 dark:border-slate-700 flex-none">
										{tool.source === "builtin" ? t.promptToolBuiltin : t.promptToolExtension}
									</span>
								</button>
							))}
						</div>
					</section>
				)}

				{data?.assembledSystemPrompt && (
					<section className="space-y-1.5">
						<div className="text-xs font-bold text-slate-800 dark:text-slate-200 px-1 mb-1">{t.promptKindAssembled}</div>
						<button
							type="button"
							className="w-full clay-card p-3 flex items-center gap-2.5 hover:scale-[1.01] transition-all cursor-pointer rounded-2xl text-left bg-white dark:bg-slate-900 shadow-sm border border-slate-200 dark:border-slate-800"
							title={t.promptAssembledKey}
							onClick={() => onOpenContent?.("system-prompt.md", data.assembledSystemPrompt ?? "")}
						>
							<div className="w-7 h-7 clay-inset bg-emerald-50 text-emerald-700 dark:bg-emerald-950/70 dark:text-emerald-300 flex items-center justify-center rounded-xl font-bold text-sm flex-none">
								π
							</div>
							<span className="truncate font-bold text-slate-900 dark:text-slate-100 text-xs">{t.promptAssembledKey}</span>
						</button>
					</section>
				)}

				{data?.compactedSummary && (
					<section className="space-y-1.5">
						<div className="text-xs font-bold text-slate-800 dark:text-slate-200 px-1 mb-1">{t.promptKindCompacted}</div>
						<button
							type="button"
							className="w-full clay-card p-3 flex items-center gap-2.5 hover:scale-[1.01] transition-all cursor-pointer rounded-2xl text-left bg-white dark:bg-slate-900 shadow-sm border border-slate-200 dark:border-slate-800"
							title={t.promptCompactedKey}
							onClick={() => onOpenContent?.("compacted-summary.md", data.compactedSummary ?? "")}
						>
							<div className="w-7 h-7 clay-inset bg-amber-50 text-amber-700 dark:bg-amber-950/70 dark:text-amber-300 flex items-center justify-center rounded-xl font-bold text-xs flex-none">
								SUM
							</div>
							<span className="truncate font-bold text-slate-900 dark:text-slate-100 text-xs">{t.promptCompactedKey}</span>
						</button>
					</section>
				)}
			</div>
		</div>
	);
}
