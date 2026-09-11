"use client";

/**
 * 大纲导航（对话区右侧）：从助手回答里的 Markdown 标题和用户消息生成锚点，
 * 收起时是一列长短不一的横线（层级越深越短），悬停展开为标题列表；
 * 随滚动高亮当前所在章节，点击平滑跳转。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/i18n";

interface OutlineItem {
	key: string;
	/** 0 = 用户消息（回合起点），1-4 = 标题层级 */
	level: number;
	text: string;
	el: HTMLElement;
}

const MIN_ITEMS = 3;
const HEADING_SELECTOR = ".md h1, .md h2, .md h3, .md h4";

export function OutlineRail({ scrollRef, revision }: { scrollRef: React.RefObject<HTMLDivElement | null>; revision: string }) {
	const { t } = useI18n();
	const [items, setItems] = useState<OutlineItem[]>([]);
	const [active, setActive] = useState(0);
	const [open, setOpen] = useState(false);
	const listRef = useRef<HTMLDivElement>(null);

	// 从 DOM 收集锚点：每条用户消息一个（回合起点），助手消息里的 h1-h4 各一个
	const collect = useCallback(() => {
		const root = scrollRef.current;
		if (!root) return;
		const out: OutlineItem[] = [];
		const roots = root.querySelectorAll<HTMLElement>('[data-role="user"], [data-role="assistant"]');
		let userIndex = 0;
		for (const node of roots) {
			if (node.dataset.role === "user") {
				userIndex += 1;
				const text = (node.textContent ?? "").replace(/\s+/g, " ").trim();
				if (text) out.push({ key: `u${userIndex}`, level: 0, text: text.slice(0, 80), el: node });
				continue;
			}
			const headings = node.querySelectorAll<HTMLElement>(HEADING_SELECTOR);
			let i = 0;
			for (const h of headings) {
				i += 1;
				const text = (h.textContent ?? "").replace(/\s+/g, " ").trim();
				if (!text) continue;
				out.push({ key: `u${userIndex}-h${i}`, level: Number(h.tagName.slice(1)), text, el: h });
			}
		}
		setItems(out);
	}, [scrollRef]);

	useEffect(() => {
		// 流式时正文在变，防抖后再抓一次；结束时立刻抓
		const timer = setTimeout(collect, revision.endsWith(":1") ? 400 : 0);
		return () => clearTimeout(timer);
	}, [collect, revision]);

	// 随滚动高亮：最后一个顶部已越过视口上沿 + 80px 的锚点
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

	const jump = (item: OutlineItem) => {
		const root = scrollRef.current;
		if (!root) return;
		const top = item.el.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop - 16;
		root.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
	};

	return (
		<div
			className="outline-rail absolute right-2 top-1/2 z-20 -translate-y-1/2"
			onMouseEnter={() => setOpen(true)}
			onMouseLeave={() => setOpen(false)}
			aria-label={t.outline}
		>
			{open ? (
				<div
					ref={listRef}
					className="max-h-[70vh] w-[260px] overflow-y-auto py-1.5"
					style={{ background: "var(--dsw-glass-popover)", border: "0.5px solid var(--dsw-border-l2)", borderRadius: 14, boxShadow: "var(--dsw-elevation-panel)" }}
				>
					{items.map((item, i) => {
						const isActive = i === active;
						return (
							<button
								key={item.key}
								type="button"
								data-active={isActive}
								className="block w-full truncate px-3 py-1 text-left transition-colors"
								style={{
									paddingLeft: 12 + Math.max(0, item.level - 1) * 12,
									fontSize: item.level === 0 ? 12.5 : 12.5,
									fontWeight: item.level === 0 ? 600 : isActive ? 600 : 400,
									color: isActive ? "var(--dsw-accent)" : item.level === 0 ? "var(--dsw-label-primary)" : "var(--dsw-label-secondary)",
									background: isActive ? "var(--dsw-accent-soft)" : "transparent",
									lineHeight: "20px",
								}}
								title={item.text}
								onMouseEnter={(e) => {
									if (!isActive) e.currentTarget.style.background = "var(--dsw-hover)";
								}}
								onMouseLeave={(e) => {
									if (!isActive) e.currentTarget.style.background = "transparent";
								}}
								onClick={() => jump(item)}
							>
								{item.text}
							</button>
						);
					})}
				</div>
			) : (
				<div className="flex flex-col items-end gap-[6px] py-2 pl-3 pr-1">
					{items.slice(0, 40).map((item, i) => (
						<span
							key={item.key}
							aria-hidden
							style={{
								display: "block",
								height: 2,
								borderRadius: 2,
								width: item.level === 0 ? 18 : Math.max(6, 16 - (item.level - 1) * 3),
								background: i === active ? "var(--dsw-accent)" : "var(--dsw-border-l4)",
								transition: "background var(--ds-duration-fast) var(--ds-ease-in-out)",
							}}
						/>
					))}
				</div>
			)}
		</div>
	);
}
