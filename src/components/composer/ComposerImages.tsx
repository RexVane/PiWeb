"use client";

/**
 * 输入卡里待发送的图片。
 * - 不超过 COLLAPSE_AT 张：平铺缩略图（不裁切），右上角删除。
 * - 更多时折叠成牌堆：正面那张在最上，后面最多露 4 层 4px 的右边缘；点「展开 N」沿一条向上拱的弧线扇开。
 *   两种状态是同一批卡片换 transform，所以有从牌堆扇开 / 收拢的动画；扇形按容器实测宽度铺开。
 *   层级始终是左压右（和牌堆同一个顺序，展开时不会闪一下换层），每张露出来的是右侧那条，
 *   删除按钮就在那条的右上角——不用悬停也点得到，触屏同样能删；张数多、条带窄到按钮会挤成一排时，
 *   只在悬停 / 聚焦的那张上显示（触屏点开预览里删）。悬停 / 聚焦的那张抬起来、整张露出。
 *   牌堆里后面几张只露空白的卡边（不露图），看起来是一叠；扇开时图再淡入。
 * - 点任意一张进预览：大图、← → 切换、删除当前张（删完自动看下一张）；Esc / 点背景 / 关闭按钮退出，焦点回到原处。
 *   预览挂到 body 上（祖先的 backdrop-filter 会让 fixed 只盖住输入卡），按键在捕获阶段拦下，不会再关掉页面上的其它面板。
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/i18n";
import type { ImageAttachment } from "@/lib/types";

/** 超过这个数量就折叠（引用 chip 用同一个阈值） */
export const COLLAPSE_AT = 4;
/** 牌堆 / 扇形里卡片的边长 */
const CARD = 96;
/** 牌堆里后面每层露出的右边缘、最多露几层（再多的叠在最后一层下面、不显示） */
const DECK_PEEK = 4;
const DECK_LAYERS = 4;
/** 扇形所在圆弧的半径（越大弧越平）、相邻两张中心的最大间距（再大就散成一排，不像一手牌了） */
const FAN_RADIUS = 520;
const FAN_GAP_MAX = 76;
/** 悬停 / 聚焦时那张往上抬多少；左右给旋转后探出去的角留的余量 */
const FAN_LIFT = 12;
const FAN_SIDE = 8;
/** 量不到宽度时（首帧、测试环境）按这个宽度排扇形 */
const FALLBACK_WIDTH = 360;

export interface CardPose {
	x: number;
	y: number;
	angle: number;
	/** 牌堆里压在最后一层下面、看不见的 */
	hidden?: boolean;
}

interface Layout {
	cards: CardPose[];
	width: number;
	height: number;
	/** 相邻两张露出来的宽度；太窄时删除按钮会挤成一排，只在悬停 / 聚焦那张上显示 */
	gap: number;
}

/** 露出的条带至少这么宽，每张的删除按钮才常驻（按钮 22px + 一点间隔） */
const ROOMY_GAP = 30;

const round = (value: number) => Math.round(value * 10) / 10;

/** 牌堆：只做横向错位，最多露 DECK_LAYERS 层 */
export function deckLayout(count: number): Layout {
	const cards = Array.from({ length: count }, (_, i) => ({ x: Math.min(i, DECK_LAYERS) * DECK_PEEK, y: 0, angle: 0, hidden: i > DECK_LAYERS }));
	return { cards, width: CARD + Math.min(Math.max(count - 1, 0), DECK_LAYERS) * DECK_PEEK, height: CARD, gap: DECK_PEEK };
}

/**
 * 扇形：卡片中心落在一段圆弧上（中间最高、两侧顺着弧下垂），每张转到切线方向；
 * 间距按可用宽度均分、不超过 FAN_GAP_MAX，从左边开始铺（离牌堆原来的位置最近）。
 */
export function fanLayout(count: number, width: number): Layout {
	const gap = count > 1 ? Math.min(FAN_GAP_MAX, Math.max(8, (width - CARD - FAN_SIDE * 2) / (count - 1))) : 0;
	const step = gap / FAN_RADIUS;
	const mid = (count - 1) / 2;
	const edge = -mid * step;
	// 正方形转过 θ 后比原来高出（也宽出）的那一截，最外侧两张最大
	const corner = (CARD / 2) * (Math.abs(Math.sin(edge)) + Math.cos(edge) - 1);
	const top = FAN_LIFT + corner;
	const cards = Array.from({ length: count }, (_, i) => {
		const theta = (i - mid) * step;
		return {
			x: round(FAN_SIDE + FAN_RADIUS * (Math.sin(theta) - Math.sin(edge))),
			y: round(top + FAN_RADIUS * (1 - Math.cos(theta))),
			angle: round((theta * 180) / Math.PI),
		};
	});
	const span = cards.length ? cards[cards.length - 1].x + CARD + FAN_SIDE : 0;
	return { cards, width: Math.ceil(span), height: Math.ceil(top + FAN_RADIUS * (1 - Math.cos(edge)) + CARD + corner), gap: round(gap) };
}

/** 每张图一个稳定的 key：前几位 base64 对同格式的图几乎都一样（PNG 都是 iVBORw0KGgo…），不能拿来当 key */
const imageKeys = new WeakMap<ImageAttachment, string>();
let nextImageKey = 0;
function keyOf(image: ImageAttachment): string {
	let key = imageKeys.get(image);
	if (!key) {
		nextImageKey += 1;
		key = `image-${nextImageKey}`;
		imageKeys.set(image, key);
	}
	return key;
}

const srcOf = (image: ImageAttachment) => `data:${image.mimeType};base64,${image.data}`;

export function ComposerImages({ images, disabled, onRemove, onClear }: { images: ImageAttachment[]; disabled?: boolean; onRemove: (index: number) => void; onClear?: () => void }) {
	const { t } = useI18n();
	const collapsible = images.length > COLLAPSE_AT;
	const [expanded, setExpanded] = useState(false);
	const fanned = collapsible && expanded;
	/** 扇形里悬停 / 聚焦的那张：抬起来、放到最上层 */
	const [lifted, setLifted] = useState<number | null>(null);
	const [preview, setPreview] = useState<number | null>(null);
	const railRef = useRef<HTMLDivElement>(null);
	const [railWidth, setRailWidth] = useState(0);

	useEffect(() => {
		const rail = railRef.current;
		if (!rail || !collapsible) return;
		// 量的是整条附件轨的内容宽度（去掉左右 4px 内边距）：扇形展开后占满这一行
		const measure = () => setRailWidth(Math.max(0, rail.clientWidth - 8));
		measure();
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(measure);
		observer.observe(rail);
		return () => observer.disconnect();
	}, [collapsible]);

	const remove = (index: number) => {
		onRemove(index);
		setLifted(null);
		// 预览里删的：还有图就接着看下一张（删的是最后一张就看前一张）
		setPreview((current) => (current === null ? null : images.length <= 1 ? null : Math.min(current, images.length - 2)));
	};

	const deleteButton = (index: number) => (
		<button type="button" className="pw-image-delete" disabled={disabled} aria-label={`${t.delete} ${index + 1}`} onClick={() => remove(index)}>
			✕
		</button>
	);

	const layout = fanned ? fanLayout(images.length, railWidth || FALLBACK_WIDTH) : deckLayout(images.length);
	const shown = preview !== null && images[preview] ? preview : null;

	return (
		<>
			<div ref={railRef} className="mb-2 flex flex-wrap items-center gap-2 px-1" data-testid="composer-images">
				{collapsible ? (
					<div
						className="pw-image-fan"
						data-testid="image-fan"
						data-expanded={fanned}
						data-crowded={fanned && layout.gap < ROOMY_GAP ? true : undefined}
						style={{ width: fanned ? "100%" : layout.width, height: layout.height }}
					>
						{images.map((image, i) => {
							const pose = layout.cards[i];
							const up = fanned && lifted === i;
							// 牌堆里只有正面那张能点、能删；后面那几张只是露个边，不进 Tab 顺序
							const reachable = fanned || i === 0;
							// 展开从左往右依次扇出，收起反过来；错开的总时长封顶，张数多也不拖沓
							const delay = Math.min(fanned ? i * 14 : (images.length - 1 - i) * 10, 140);
							return (
								<div
									key={keyOf(image)}
									className="pw-image-card"
									data-hidden={pose.hidden || undefined}
									data-lifted={up || undefined}
									style={{
										zIndex: up ? images.length + 1 : images.length - i,
										transform: `translate(${pose.x}px, ${pose.y - (up ? FAN_LIFT : 0)}px) rotate(${pose.angle}deg)`,
										transitionDelay: up || lifted !== null ? "0ms" : `${delay}ms`,
									}}
									onMouseEnter={() => fanned && setLifted(i)}
									onMouseLeave={() => setLifted((current) => (current === i ? null : current))}
									onFocus={() => fanned && setLifted(i)}
									onBlur={(event) => {
										// 焦点从图片挪到同一张的删除按钮不算离开
										if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setLifted((current) => (current === i ? null : current));
									}}
								>
									<button
										type="button"
										className="pw-image-face"
										tabIndex={reachable ? undefined : -1}
										aria-hidden={reachable ? undefined : true}
										title={t.imagePreview}
										aria-label={t.imagePreview}
										onClick={() => setPreview(i)}
									>
										<img src={srcOf(image)} alt="" className="h-full w-full object-contain" draggable={false} />
									</button>
									{reachable ? deleteButton(i) : null}
								</div>
							);
						})}
					</div>
				) : (
					images.map((image, i) => (
						<div key={keyOf(image)} className="pw-image-thumb">
							<button type="button" className="block" title={t.imagePreview} aria-label={t.imagePreview} onClick={() => setPreview(i)}>
								<img src={srcOf(image)} alt="" className="max-h-24 max-w-32 rounded-[10px] object-contain" draggable={false} />
							</button>
							{deleteButton(i)}
						</div>
					))
				)}
				{images.length > 1 && onClear ? (
					<button
						type="button"
						className="pw-chip"
						data-testid="images-clear"
						disabled={disabled}
						onClick={() => {
							onClear();
							setLifted(null);
							setPreview(null);
						}}
					>
						{t.imageClearAll}
					</button>
				) : null}
				{collapsible ? (
					<button
						type="button"
						className="pw-chip"
						data-testid="images-toggle"
						aria-expanded={fanned}
						onClick={() => {
							setExpanded((open) => !open);
							setLifted(null);
						}}
					>
						{fanned ? t.chipCollapse : t.chipExpandMore.replace("{n}", String(images.length - 1))}
					</button>
				) : null}
			</div>
			{shown !== null
				? createPortal(
					<ImageViewer images={images} index={shown} disabled={disabled} onIndex={setPreview} onRemove={remove} onClose={() => setPreview(null)} />,
					document.body,
				)
				: null}
		</>
	);
}

/** 放大预览：手机上没法用本机程序打开图片，应用内看最实在 */
function ImageViewer({
	images,
	index,
	disabled,
	onIndex,
	onRemove,
	onClose,
}: {
	images: ImageAttachment[];
	index: number;
	disabled?: boolean;
	onIndex: (index: number) => void;
	onRemove: (index: number) => void;
	onClose: () => void;
}) {
	const { t } = useI18n();
	const dialogRef = useRef<HTMLDivElement>(null);
	const closeRef = useRef<HTMLButtonElement>(null);
	const count = images.length;
	const go = (delta: number) => onIndex((index + delta + count) % count);

	// 打开时把焦点移进来，关掉时还给原来那个元素（还在页面上的话）
	useEffect(() => {
		const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		closeRef.current?.focus();
		return () => {
			if (opener?.isConnected) opener.focus();
		};
	}, []);

	// 捕获阶段处理：Esc / 方向键不再传给页面上其它监听 document 的面板；Tab 只在预览里转
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") onClose();
			else if (event.key === "ArrowLeft" && count > 1) go(-1);
			else if (event.key === "ArrowRight" && count > 1) go(1);
			else if (event.key === "Tab") {
				const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>("button:not(:disabled)") ?? [])];
				if (!focusable.length) return;
				const at = focusable.indexOf(document.activeElement as HTMLElement);
				const next = event.shiftKey ? (at <= 0 ? focusable.length - 1 : at - 1) : at === focusable.length - 1 ? 0 : at + 1;
				focusable[next].focus();
			} else return;
			event.preventDefault();
			event.stopPropagation();
		};
		document.addEventListener("keydown", onKey, true);
		return () => document.removeEventListener("keydown", onKey, true);
		// onClose / onIndex 来自父组件的 setState 包装，语义不变；只随张数和当前张重绑
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [count, index]);

	return (
		<div ref={dialogRef} className="pw-lightbox" role="dialog" aria-modal="true" aria-label={t.imageViewer} onClick={onClose}>
			<div className="pw-lightbox-bar" onClick={(event) => event.stopPropagation()}>
				<span className="pw-lightbox-count">{count > 1 ? `${index + 1} / ${count}` : ""}</span>
				<button type="button" className="pw-lightbox-btn" disabled={disabled} onClick={() => onRemove(index)}>
					{t.delete}
				</button>
				<button ref={closeRef} type="button" className="pw-lightbox-btn" aria-label={t.close} onClick={onClose}>
					✕
				</button>
			</div>
			<img src={srcOf(images[index])} alt="" className="pw-lightbox-image" onClick={(event) => event.stopPropagation()} />
			{count > 1 ? (
				<>
					<button type="button" className="pw-lightbox-nav" data-side="prev" aria-label={t.imagePrev} onClick={(event) => { event.stopPropagation(); go(-1); }}>
						‹
					</button>
					<button type="button" className="pw-lightbox-nav" data-side="next" aria-label={t.imageNext} onClick={(event) => { event.stopPropagation(); go(1); }}>
						›
					</button>
				</>
			) : null}
		</div>
	);
}
