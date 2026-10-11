"use client";

/**
 * 大纲导航（对话区右侧）。
 *
 * 展开态按「回合」组织，一行一个回合：
 *   ┌───────────────┬──────────────────────────────┐
 *   │ 10月8日 16:49 │  用户提示词……                 │  ← 左：浅灰、不显眼的时间与轮数（比右侧矮一档）
 *   │ 第 3 轮        │                              │  ← 右：用户提示词
 *   └───────────────┴──────────────────────────────┘
 * 鼠标悬停某一行时，在其下方展开该回合回答里的小标题（回复 title），可点击跳转。
 * 同一时刻只展开一个回合（手风琴）。随滚动高亮当前回合。
 *
 * 收起态仍是一列长短不一的横线（回合起点最宽，回复小标题按层级递减），悬停整条栏展开。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/i18n";

interface ReplyTitle {
	key: string;
	/** 1-4 = 标题层级 */
	level: number;
	text: string;
	el: HTMLElement;
}

interface TurnItem {
	key: string;
	/** 用户消息里的时钟文本（可能为空：纯图片消息没有动作行） */
	time: string;
	/** 第几轮（从 1 开始） */
	round: number;
	/** 用户提示词（已折叠空白、截断） */
	prompt: string;
	/** 回合起点（用户消息节点），点击跳到这里 */
	el: HTMLElement;
	replyTitles: ReplyTitle[];
}

const MIN_ITEMS = 3;
const HEADING_SELECTOR = ".md h1, .md h2, .md h3, .md h4";
const PROMPT_MAX = 120;

export function OutlineRail({ scrollRef, revision }: { scrollRef: React.RefObject<HTMLDivElement | null>; revision: string }) {
	const { t } = useI18n();
	const [items, setItems] = useState<TurnItem[]>([]);
	const [active, setActive] = useState(0);
	const [open, setOpen] = useState(false);
	/** 当前展开回复标题的回合 key（手风琴：同一时刻只有一个） */
	const [expanded, setExpanded] = useState<string | null>(null);
	const listRef = useRef<HTMLDivElement>(null);

	// 从 DOM 收集锚点：按「用户消息 → 其后助手消息里的 h1-h4」聚成一个回合
	const collect = useCallback(() => {
		const root = scrollRef.current;
		if (!root) return;
		const out: TurnItem[] = [];
		const nodes = root.querySelectorAll<HTMLElement>('[data-role="user"], [data-role="assistant"]');
		let round = 0;
		let current: TurnItem | null = null;
		for (const node of nodes) {
			if (node.dataset.role === "user") {
				round += 1;
				// 只取气泡里的正文：用户行里还有时间戳和操作按钮，整行 textContent 会混进「10月7日 16:49」；
				// 正文还没加载出来时宁可先不出这一项，等下面的 MutationObserver 再收一次
				const bubble = node.querySelector<HTMLElement>(".msg-user-bubble");
				const prompt = (bubble?.textContent ?? "").replace(/\s+/g, " ").trim();
				const time = node.querySelector<HTMLElement>(".msg-clock")?.textContent?.trim() ?? "";
				current = { key: `u${round}`, time, round, prompt: prompt.slice(0, PROMPT_MAX), el: node, replyTitles: [] };
				out.push(current);
				continue;
			}
			if (!current) continue;
			let i = 0;
			for (const heading of node.querySelectorAll<HTMLElement>(HEADING_SELECTOR)) {
				i += 1;
				const text = (heading.textContent ?? "").replace(/\s+/g, " ").trim();
				if (!text) continue;
				current.replyTitles.push({ key: `${current.key}-h${i}`, level: Number(heading.tagName.slice(1)), text, el: heading });
			}
		}
		// 提示词与回复标题都还没有的回合先不列（正文按需加载时会再收一次，避免只剩时间戳）
		setItems(out.filter((turn) => turn.prompt || turn.replyTitles.length > 0));
	}, [scrollRef]);

	useEffect(() => {
		// 流式时正文在变，防抖后再抓一次；结束时立刻抓
		const timer = setTimeout(collect, revision.endsWith(":1") ? 400 : 0);
		return () => clearTimeout(timer);
	}, [collect, revision]);

	// 正文是按需加载的 Markdown（见 ChatWindow 的 dynamic import）：刷新后直接恢复会话时，快照到了
	// 正文可能还没出来；懒渲染的回合滚到附近才升级。这些都不改 revision，所以盯 DOM 结构变化再收一次。
	// 只看 childList，流式逐字改文本不触发；防抖合并成一次。
	useEffect(() => {
		const root = scrollRef.current;
		if (!root) return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const observer = new MutationObserver(() => {
			clearTimeout(timer);
			timer = setTimeout(collect, 300);
		});
		observer.observe(root, { childList: true, subtree: true });
		return () => {
			observer.disconnect();
			clearTimeout(timer);
		};
	}, [collect, scrollRef]);

	// 随滚动高亮：最后一个顶部已越过视口上沿 + 80px 的回合
	useEffect(() => {
		const root = scrollRef.current;
		if (!root || !items.length) return;
		let frame = 0;
		const update = () => {
			frame = 0;
			const rootTop = root.getBoundingClientRect().top;
			const threshold = rootTop + 80;
			let current = 0;
			for (let i = 0; i < items.length; i += 1) {
				if (items[i].el.getBoundingClientRect().top <= threshold) current = i;
				else break;
			}
			setActive(current);
		};
		const onScroll = () => {
			if (!frame) frame = requestAnimationFrame(update);
		};
		update();
		root.addEventListener("scroll", onScroll, { passive: true });
		return () => {
			root.removeEventListener("scroll", onScroll);
			if (frame) cancelAnimationFrame(frame);
		};
	}, [items, scrollRef]);

	// 展开时把当前项滚到列表可见范围
	useEffect(() => {
		if (!open) return;
		listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
	}, [open, active]);

	if (items.length < MIN_ITEMS) return null;

	const jump = (el: HTMLElement) => {
		const root = scrollRef.current;
		if (!root) return;
		const top = el.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop - 16;
		root.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
	};

	// 收起态的一列横线：回合起点最宽，回复小标题按层级递减；当前回合的起点高亮
	const bars = items.flatMap((turn, i) => [
		{ key: turn.key, level: 0, isActive: i === active },
		...turn.replyTitles.map((h) => ({ key: h.key, level: h.level, isActive: false })),
	]);

	return (
		<div
			className="outline-rail absolute right-2 top-1/2 z-20 -translate-y-1/2"
			onMouseEnter={() => setOpen(true)}
			onMouseLeave={() => { setOpen(false); setExpanded(null); }}
			aria-label={t.outline}
		>
			{open ? (
				<div
					ref={listRef}
					className="max-h-[70vh] w-[300px] overflow-y-auto py-1.5"
					style={{ background: "var(--dsw-glass-popover)", border: "0.5px solid var(--dsw-border-l2)", borderRadius: 14, boxShadow: "var(--dsw-elevation-panel)" }}
					onMouseLeave={() => setExpanded(null)}
				>
					{items.map((turn, i) => {
						const isActive = i === active;
						const isExpanded = expanded === turn.key;
						return (
							<div key={turn.key} data-round={turn.round} data-active={isActive} className="outline-turn" onMouseEnter={() => setExpanded(turn.key)}>
								<button
									type="button"
									className="outline-turn-main block w-full text-left"
									title={turn.prompt || turn.replyTitles[0]?.text || turn.time}
									onClick={() => jump(turn.el)}
									style={{
										display: "grid",
										gridTemplateColumns: "auto minmax(0, 1fr)",
										columnGap: 10,
										alignItems: "start",
										padding: "5px 12px",
										background: isActive ? "var(--dsw-accent-soft)" : "transparent",
										transition: "background var(--ds-duration-fast) var(--ds-ease-in-out)",
									}}
									onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = "var(--dsw-hover)"; }}
									onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = "transparent"; }}
								>
									{/* 左：浅灰、不显眼的时间与轮数（比右侧的提示词矮一档） */}
									<span className="outline-turn-meta" style={{ color: "var(--dsw-label-caption)", fontSize: 10, lineHeight: "14px", whiteSpace: "nowrap", paddingTop: 2 }}>
										{turn.time && <span style={{ display: "block" }}>{turn.time}</span>}
										<span style={{ display: "block", opacity: 0.85 }}>{t.outlineRound.replace("{n}", String(turn.round))}</span>
									</span>
									{/* 右：用户提示词（最多两行） */}
									<span
										className="outline-turn-prompt"
										style={{
											color: isActive ? "var(--dsw-accent)" : "var(--dsw-label-primary)",
											fontSize: 12.5,
											lineHeight: "18px",
											fontWeight: isActive ? 600 : 500,
											display: "-webkit-box",
											WebkitLineClamp: 2,
											WebkitBoxOrient: "vertical",
											overflow: "hidden",
										}}
									>
										{turn.prompt || turn.replyTitles[0]?.text || t.outlineNoPrompt}
									</span>
								</button>
								{/* 悬停展开：该回合回答里的小标题（回复 title），可点击跳转 */}
								{isExpanded && turn.replyTitles.length > 0 && (
									<div className="outline-turn-replies" style={{ padding: "1px 12px 6px 12px" }}>
										{turn.replyTitles.map((h) => (
											<button
												key={h.key}
												type="button"
												className="block w-full truncate text-left"
												title={h.text}
												onClick={() => jump(h.el)}
												style={{
													padding: `3px 6px 3px ${8 + Math.max(0, h.level - 1) * 10}px`,
													borderRadius: 6,
													fontSize: 12,
													lineHeight: "17px",
													color: "var(--dsw-label-secondary)",
												}}
												onMouseEnter={(e) => { e.currentTarget.style.background = "var(--dsw-hover)"; }}
												onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
											>
												{h.text}
											</button>
										))}
									</div>
								)}
							</div>
						);
					})}
				</div>
			) : (
				<div className="flex flex-col items-end gap-[6px] py-2 pl-3 pr-1">
					{bars.slice(0, 40).map((bar) => (
						<span
							key={bar.key}
							aria-hidden
							style={{
								display: "block",
								height: 2,
								borderRadius: 2,
								width: bar.level === 0 ? 18 : Math.max(6, 16 - (bar.level - 1) * 3),
								background: bar.isActive ? "var(--dsw-accent)" : "var(--dsw-border-l4)",
								transition: "background var(--ds-duration-fast) var(--ds-ease-in-out)",
							}}
						/>
					))}
				</div>
			)}
		</div>
	);
}
