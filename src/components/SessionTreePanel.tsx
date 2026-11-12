"use client";
/**
 * 会话分支面板：把 pi 会话树上的每一问列出来（pi 终端的 /tree）。
 *
 * 会话是一棵只追加的树：编辑重发、回到某一步再提问都会长出新分支，旧分支还在文件里。
 * 这里每一问一行，直线对话平铺，分叉处缩进并画分叉记号。
 *  - 点当前分支上的提问：跳到对话里的那一问；
 *  - 点别的分支上的提问：切到那条分支（把会话的叶子挪到它下面最新的位置）；
 *  - 图钉：给这一问打标签（存进会话文件，pi 终端的 /tree 里同样看得到）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { IconBranchOutline16, IconCloseOutline14, IconPinFill16, IconPinOutline16, IconRefreshOutline14 } from "@/components/icons";
import { useI18n } from "@/i18n";
import type { SessionTree, SessionTreeNode } from "@/lib/session-tree";

const INDENT_PX = 14;

/** 换会话时整份面板状态一起重置，旧树和异步操作不能串到新会话。 */
export function SessionTreePanel(props: Parameters<typeof SessionTreePanelContent>[0]) {
	return <SessionTreePanelContent {...props} key={props.sessionId} />;
}

function SessionTreePanelContent({
	sessionId,
	refreshKey,
	running,
	onJump,
	onSwitch,
	onSetLabel,
	onClose,
}: {
	/** URL 里用的会话 id；没有打开会话时为 null */
	sessionId: string | null;
	/** 变了就重新拉树（换会话、回合结束） */
	refreshKey?: string | number | null;
	/** pi 正在跑：这时不能换分支 */
	running?: boolean;
	/** 当前分支上的提问：跳到对话里 */
	onJump: (entryId: string) => void;
	/** 切到另一条分支；返回是否成功 */
	onSwitch: (leafId: string) => Promise<boolean>;
	/** 打标签（空串 = 清掉）；返回是否成功 */
	onSetLabel: (entryId: string, label: string) => Promise<boolean>;
	onClose: () => void;
}) {
	const { t } = useI18n();
	const [tree, setTree] = useState<SessionTree | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	/** 正在切过去的那条分支的叶子：期间整列不再响应点击 */
	const [switching, setSwitching] = useState<string | null>(null);
	const [editing, setEditing] = useState<string | null>(null);
	const [draft, setDraft] = useState("");
	const requestRef = useRef(0);
	const mountedRef = useRef(true);

	const load = useCallback(async () => {
		// 旧会话上的切分支 / 标签保存可以稍后才结束，结束后不再发起旧会话的刷新。
		if (!mountedRef.current) return;
		const request = ++requestRef.current;
		if (!sessionId) {
			setTree(null);
			setError("");
			setBusy(false);
			return;
		}
		setBusy(true);
		try {
			const response = await fetch(`/api/agent/${sessionId}/tree`);
			const json = await response.json();
			if (request !== requestRef.current) return; // 期间又换了会话 / 又拉了一次：丢掉这份过期结果
			if (!response.ok || !json.success) throw new Error(json.error || `request failed (${response.status})`);
			setTree({ nodes: json.data.nodes ?? [], leafId: json.data.leafId ?? null, truncated: json.data.truncated === true });
			setError("");
		} catch (failure) {
			if (request !== requestRef.current) return;
			setError(failure instanceof Error ? failure.message : String(failure));
		} finally {
			if (request === requestRef.current) setBusy(false);
		}
	}, [sessionId]);

	useEffect(() => {
		mountedRef.current = true;
		setEditing(null);
		void load();
		return () => {
			mountedRef.current = false;
			requestRef.current += 1;
		};
	}, [load, refreshKey]);

	const activate = async (node: SessionTreeNode) => {
		if (node.active) {
			onJump(node.entryId);
			return;
		}
		if (running || switching) return;
		setSwitching(node.leafId);
		try {
			if (await onSwitch(node.leafId)) await load();
		} finally {
			if (mountedRef.current) setSwitching(null);
		}
	};

	const saveLabel = async (node: SessionTreeNode) => {
		const next = draft.trim();
		setEditing(null);
		if (next === (node.label ?? "")) return;
		if (await onSetLabel(node.entryId, next)) await load();
	};

	const nodes = tree?.nodes ?? [];
	return (
		<div className="flex h-full min-h-0 flex-col" data-testid="session-tree-panel">
			<div className="hairline-b flex items-center gap-2 px-4 py-2.5">
				<span className="min-w-0 flex-1 truncate" style={{ fontSize: 13.5, fontWeight: 600 }}>{t.sessionTree}</span>
				<button type="button" className="icon-btn" style={{ width: 26, height: 26 }} title={t.sessionTreeRefresh} aria-label={t.sessionTreeRefresh} onClick={() => void load()}>
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
						{t.sessionTreeLoadFailed}：{error}
					</div>
				)}
				{!sessionId ? (
					<div style={{ color: "var(--dsw-label-caption)" }}>{t.sessionTreeNoSession}</div>
				) : tree && nodes.length === 0 ? (
					<div style={{ color: "var(--dsw-label-caption)" }}>{t.sessionTreeEmpty}</div>
				) : (
					<>
						{nodes.length > 0 && <div className="mb-2" style={{ color: "var(--dsw-label-caption)", lineHeight: 1.5 }}>{running ? t.sessionTreeBusy : t.sessionTreeHint}</div>}
						<ul className="flex flex-col gap-0.5" style={{ margin: 0, padding: 0, listStyle: "none" }} aria-label={t.sessionTree}>
							{nodes.map((node) => {
								const blocked = !node.active && (Boolean(running) || switching !== null);
								const action = node.active ? t.sessionTreeJump : running ? t.sessionTreeBusy : t.sessionTreeSwitch;
								const title = node.current ? `${t.sessionTreeCurrent} · ${action}` : action;
								return (
									<li
										key={node.entryId}
										className="group/node flex items-center gap-1.5 rounded-lg"
										data-active={node.active || undefined}
										data-current={node.current || undefined}
										data-forked={node.forked || undefined}
										style={{ paddingLeft: 4 + node.indent * INDENT_PX, background: node.current ? "var(--dsw-hover)" : undefined }}
									>
										<span aria-hidden className="flex flex-none items-center justify-center" style={{ width: 14, height: 26, color: node.active ? "var(--dsw-accent)" : "var(--dsw-label-caption)" }}>
											{node.forked ? <IconBranchOutline16 size={12} /> : <span style={{ width: 5, height: 5, borderRadius: 999, background: "currentColor", opacity: node.current ? 1 : 0.55 }} />}
										</span>
										<button
											type="button"
											className="min-w-0 flex-1 truncate py-1 text-left"
											style={{
												color: node.current ? "var(--dsw-label-primary)" : node.active ? "var(--dsw-label-secondary)" : "var(--dsw-label-caption)",
												fontWeight: node.current ? 600 : 400,
												cursor: blocked ? "not-allowed" : "pointer",
												opacity: switching === node.leafId ? 0.6 : 1,
											}}
											title={`${title}\n${node.text}`}
											aria-current={node.current ? "true" : undefined}
											aria-disabled={blocked || undefined}
											onClick={() => void activate(node)}
										>
											{node.text || t.sessionTreeEmptyPrompt}
										</button>
										{node.branches > 1 && (
											<span className="flex-none" style={{ fontSize: 11, color: "var(--dsw-label-caption)" }} title={t.sessionTreeBranches.replace("{n}", String(node.branches))}>
												×{node.branches}
											</span>
										)}
										{editing === node.entryId ? (
											<input
												autoFocus
												value={draft}
												maxLength={80}
												placeholder={t.sessionTreeLabelPlaceholder}
												aria-label={t.sessionTreeLabel}
												onChange={(event) => setDraft(event.target.value)}
												onBlur={() => setEditing(null)}
												onKeyDown={(event) => {
													if (event.nativeEvent.isComposing) return;
													if (event.key === "Enter") void saveLabel(node);
													else if (event.key === "Escape") {
														event.stopPropagation();
														setEditing(null);
													}
												}}
												className="flex-none rounded-md px-1.5 py-0.5"
												style={{ width: 120, fontSize: 12, background: "var(--dsw-bg-elevated)", border: "0.5px solid var(--dsw-border-l2)" }}
											/>
										) : (
											<>
												{node.label && (
													<span className="max-w-[40%] flex-none truncate rounded-full px-1.5" style={{ fontSize: 11, lineHeight: "18px", color: "var(--dsw-accent)", background: "var(--dsw-accent-soft)" }} title={node.label}>
														{node.label}
													</span>
												)}
												{node.otherLabels?.map((label, index) => (
													<span key={`${label}-${index}`} className="max-w-[30%] flex-none truncate rounded-full px-1.5" style={{ fontSize: 11, lineHeight: "18px", color: "var(--dsw-label-caption)", border: "0.5px solid var(--dsw-border-l2)" }} title={label}>
														{label}
													</span>
												))}
												<button
													type="button"
													className={`icon-btn flex-none ${node.label ? "" : "opacity-0 group-hover/node:opacity-100 focus-visible:opacity-100"}`}
													style={{ width: 22, height: 22 }}
													title={node.label ? t.sessionTreeLabelEdit : t.sessionTreeLabelAdd}
													aria-label={`${node.label ? t.sessionTreeLabelEdit : t.sessionTreeLabelAdd}：${node.text || t.sessionTreeEmptyPrompt}`}
													onClick={() => {
														setDraft(node.label ?? "");
														setEditing(node.entryId);
													}}
												>
													{node.label ? <IconPinFill16 size={12} /> : <IconPinOutline16 size={12} />}
												</button>
											</>
										)}
									</li>
								);
							})}
						</ul>
						{tree?.truncated && <div className="mt-2" style={{ color: "var(--dsw-label-caption)" }}>{t.sessionTreeTruncated.replace("{n}", String(nodes.length))}</div>}
					</>
				)}
			</div>
		</div>
	);
}
