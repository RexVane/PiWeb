"use client";
/**
 * 提示词面板：把"发给模型的提示词从哪来"集中列出来，点某一项查看原文。
 *
 * 只读：文件类来源的路径来自 Pi 资源加载器（项目记忆 / 系统提示词覆盖 / 追加提示词 /
 * 技能 / 提示模板，含扩展与 npm 包提供的那些）；热会话额外给出"组装后的系统提示词"
 * 与每个工具的定义，它们不是文件、没有路径，直接在本面板内展开查看。
 */
import { useCallback, useEffect, useState } from "react";
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
	const [data, setData] = useState<PromptSourcesData | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [opening, setOpening] = useState<string | null>(null);

	const load = useCallback(async () => {
		setBusy(true);
		setError(null);
		try {
			const query = new URLSearchParams({ cwd });
			if (sessionId) query.set("session", sessionId);
			const response = await fetch(`/api/prompts?${query.toString()}`);
			const body = await response.json();
			if (!response.ok || !body.success) throw new Error(body.error || `request failed (${response.status})`);
			setData(body.data as PromptSourcesData);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	}, [cwd, sessionId]);

	useEffect(() => {
		void load();
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
		setOpening(source.path);
		setError(null);
		try {
			const response = await fetch("/api/prompts", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ action: "read", filePath: source.path, cwd }),
			});
			const body = await response.json();
			if (!response.ok || !body.success) throw new Error(body.error || "read failed");
			onOpenContent(source.path, body.data.content as string);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setOpening(null);
		}
	};

	const groups = GROUP_KINDS.map((kind) => ({ kind, items: (data?.sources ?? []).filter((source) => source.kind === kind) })).filter(
		(group) => group.items.length > 0,
	);
	const hasTools = (data?.tools?.length ?? 0) > 0;

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="hairline-b flex items-center gap-2 px-4 py-2.5">
				<span className="min-w-0 flex-1 truncate" style={{ fontSize: 13.5, fontWeight: 600 }}>{t.promptPanel}</span>
				<button type="button" className="icon-btn" style={{ width: 26, height: 26 }} title={t.promptRefresh} aria-label={t.promptRefresh} onClick={() => void load()}>
					<span className={busy ? "piweb-spin" : undefined} style={{ display: "inline-flex" }}>
						<IconRefreshOutline14 size={14} />
					</span>
				</button>
				<button type="button" className="icon-btn" style={{ width: 26, height: 26 }} title={t.close} aria-label={t.close} onClick={onClose}>
					<IconCloseOutline14 size={14} />
				</button>
			</div>
			<div className="min-h-0 flex-1 overflow-auto px-3 py-3" style={{ fontSize: 12.5 }}>
				{error && (
					<div className="mb-2 rounded-lg px-2 py-1.5" style={{ background: "var(--dsw-hover)", color: "var(--dsw-danger)" }} role="alert">
						{error}
					</div>
				)}
				{!data && busy && <div style={{ color: "var(--dsw-label-tertiary)" }}>{t.promptLoading}</div>}
				{data && !data.sessionReady && (
					<div className="mb-2 rounded-lg px-2 py-1.5" style={{ background: "var(--dsw-hover)", color: "var(--dsw-label-caption)" }} role="status">
						{t.promptColdHint}
					</div>
				)}

				{groups.map((group) => (
					<section key={group.kind} className="mb-3">
						<div className="mb-1 px-1" style={{ fontSize: 11.5, color: "var(--dsw-label-caption)" }}>{kindLabel(group.kind)}</div>
						<div className="flex flex-col gap-1">
							{group.items.map((source) => (
								<button
									key={`${source.kind}:${source.path ?? source.name}`}
									type="button"
									className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left"
									style={{ background: opening === source.path ? "var(--dsw-active)" : "transparent", border: "0.5px solid var(--dsw-border-l2)" }}
									title={source.path ?? source.name}
									onClick={() => void openFile(source)}
								>
									<span className="min-w-0 flex-1 truncate" style={{ color: "var(--dsw-label-primary)" }}>{source.name}</span>
									<span className="flex-none" style={{ fontSize: 10.5, color: "var(--dsw-label-tertiary)" }}>{formatBytes(source.bytes)}</span>
									<span className="flex-none rounded-md px-1.5 py-0.5" style={{ fontSize: 10.5, border: "0.5px solid var(--dsw-border-l3)", color: "var(--dsw-label-tertiary)" }}>
										{originLabel(source.origin)}
									</span>
								</button>
							))}
						</div>
					</section>
				))}

				{hasTools && (
					<section className="mb-3">
						<div className="mb-1 px-1" style={{ fontSize: 11.5, color: "var(--dsw-label-caption)" }}>{t.promptKindTool}</div>
						<div className="flex flex-col gap-1">
							{data!.tools!.map((tool) => (
								<button
									key={`tool:${tool.name}`}
									type="button"
									className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left"
									style={{ border: "0.5px solid var(--dsw-border-l2)" }}
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
									<span className="min-w-0 flex-1 truncate" style={{ color: "var(--dsw-label-primary)" }}>{tool.name}</span>
									<span className="flex-none rounded-md px-1.5 py-0.5" style={{ fontSize: 10.5, border: "0.5px solid var(--dsw-border-l3)", color: "var(--dsw-label-tertiary)" }}>
										{tool.source === "builtin" ? t.promptToolBuiltin : t.promptToolExtension}
									</span>
								</button>
							))}
						</div>
					</section>
				)}

				{data?.assembledSystemPrompt && (
					<section className="mb-3">
						<div className="mb-1 px-1" style={{ fontSize: 11.5, color: "var(--dsw-label-caption)" }}>{t.promptKindAssembled}</div>
						<button
							type="button"
							className="w-full rounded-lg px-2 py-1.5 text-left"
							style={{ border: "0.5px solid var(--dsw-border-l2)" }}
							title={t.promptAssembledKey}
							onClick={() => onOpenContent?.("system-prompt.md", data.assembledSystemPrompt ?? "")}
						>
							<span className="truncate" style={{ color: "var(--dsw-label-primary)" }}>{t.promptAssembledKey}</span>
						</button>
					</section>
				)}

				{data?.compactedSummary && (
					<section className="mb-3">
						<div className="mb-1 px-1" style={{ fontSize: 11.5, color: "var(--dsw-label-caption)" }}>{t.promptKindCompacted}</div>
						<button
							type="button"
							className="w-full rounded-lg px-2 py-1.5 text-left"
							style={{ border: "0.5px solid var(--dsw-border-l2)" }}
							title={t.promptCompactedKey}
							onClick={() => onOpenContent?.("compacted-summary.md", data.compactedSummary ?? "")}
						>
							<span className="truncate" style={{ color: "var(--dsw-label-primary)" }}>{t.promptCompactedKey}</span>
						</button>
					</section>
				)}
			</div>
		</div>
	);
}
