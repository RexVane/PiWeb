"use client";

/**
 * 输入卡里上传的文件列表（多文件牌堆与竖直向上弧度展开）：
 * - 不超过 COLLAPSE_AT 个：平铺文件 chip。
 * - 超过时折叠成牌堆：第一张在最上，后面露 4 层边，显示「展开 N」；
 * - 点「展开」沿竖直向上呈优美弧度扇开，每张都可以单独删除或悬停预览，
 *   点击「收起」平滑收回牌堆；与图片牌堆/扇形拥有一致的动效与交互质感。
 */
import { useEffect, useRef, useState } from "react";
import { IconFileOutline16 } from "@/components/icons";
import { useI18n } from "@/i18n";
import { fmtBytes } from "@/lib/format";

export const COLLAPSE_AT = 4;
const FILE_CARD_W = 196;
const FILE_CARD_H = 32;
const DECK_PEEK = 4;
const DECK_LAYERS = 4;
const FAN_SIDE = 6;

export interface FileCardPose {
	x: number;
	y: number;
	angle: number;
	hidden?: boolean;
}

interface FileLayout {
	cards: FileCardPose[];
	width: number;
	height: number;
	gap: number;
}

const round = (value: number) => Math.round(value * 10) / 10;
const fmtUploadSize = (bytes?: number) => (bytes ? fmtBytes(bytes) : "");

export function fileDeckLayout(count: number): FileLayout {
	const cards = Array.from({ length: count }, (_, i) => ({
		x: Math.min(i, DECK_LAYERS) * DECK_PEEK,
		y: 0,
		angle: 0,
		hidden: i >= DECK_LAYERS,
	}));
	return {
		cards,
		width: FILE_CARD_W + Math.min(Math.max(count - 1, 0), DECK_LAYERS) * DECK_PEEK,
		height: FILE_CARD_H,
		gap: DECK_PEEK,
	};
}

export function fileFanLayout(count: number, width: number): FileLayout {
	if (count <= 1) {
		return { cards: [{ x: FAN_SIDE, y: 0, angle: 0 }], width: FILE_CARD_W + FAN_SIDE * 2, height: FILE_CARD_H, gap: 0 };
	}
	// 垂直每张抬升步长：自适应压窄，保证上方不顶出视口
	const stepY = Math.min(32, Math.max(16, 220 / (count - 1)));
	const spanY = (count - 1) * stepY;
	const totalH = FILE_CARD_H + spanY + 14;
	const cards = Array.from({ length: count }, (_, i) => {
		const progress = i / (count - 1);
		// y 轴：第 0 张在底部，最后一张在最上方
		const y = round((totalH - FILE_CARD_H - 6) - i * stepY);
		// x 轴：向上升起时呈优雅的弧度向右轻微弯出
		const arcX = 18 * Math.sin(progress * Math.PI);
		const x = round(FAN_SIDE + arcX + progress * 10);
		// 角度：从下方的 -3° 顺滑过渡到上方的 +5°
		const angle = round(-3 + progress * 8);
		return { x, y, angle };
	});
	const maxX = Math.max(...cards.map((c) => c.x)) + FILE_CARD_W + FAN_SIDE;
	return {
		cards,
		width: Math.min(width, Math.max(FILE_CARD_W + 32, Math.ceil(maxX))),
		height: Math.ceil(totalH),
		gap: round(stepY),
	};
}

export interface UploadFileItem {
	name: string;
	path: string;
	size?: number;
}

export function ComposerFiles({
	files,
	disabled,
	onRemove,
	onClear,
}: {
	files: UploadFileItem[];
	disabled?: boolean;
	onRemove: (index: number) => void;
	onClear?: () => void;
}) {
	const { t } = useI18n();
	const collapsible = files.length > COLLAPSE_AT;
	const [expanded, setExpanded] = useState(false);
	const fanned = collapsible && expanded;
	const [lifted, setLifted] = useState<number | null>(null);
	const railRef = useRef<HTMLDivElement>(null);
	const [railWidth, setRailWidth] = useState(360);

	useEffect(() => {
		const rail = railRef.current;
		if (!rail || !collapsible) return;
		const measure = () => setRailWidth(Math.max(280, rail.clientWidth - 8));
		measure();
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(measure);
		observer.observe(rail);
		return () => observer.disconnect();
	}, [collapsible]);

	const layout = fanned ? fileFanLayout(files.length, railWidth) : fileDeckLayout(files.length);

	const renderFileCard = (f: UploadFileItem, i: number, pose?: FileCardPose, isDeck = false) => {
		const up = fanned && lifted === i;
		const delay = Math.min(fanned ? i * 14 : (files.length - 1 - i) * 10, 140);
		const isHidden = !fanned && isDeck && i >= DECK_LAYERS;
		if (isHidden) return null;

		return (
			<div
				key={`${f.path}:${i}`}
				className="pw-ref-chip group/ref pw-file-card"
				title={f.path}
				data-lifted={up || undefined}
				style={
					pose
						? {
								position: "absolute",
								left: 0,
								top: 0,
								width: FILE_CARD_W,
								height: FILE_CARD_H,
								zIndex: up ? files.length + 2 : fanned ? i + 1 : files.length - i,
								transform: `translate(${pose.x}px, ${pose.y - (up ? 4 : 0)}px) rotate(${pose.angle}deg) ${up ? "scale(1.04)" : ""}`,
								transitionDelay: up || lifted !== null ? "0ms" : `${delay}ms`,
						  }
						: undefined
				}
				onMouseEnter={() => fanned && setLifted(i)}
				onMouseLeave={() => setLifted((cur) => (cur === i ? null : cur))}
				onFocus={() => fanned && setLifted(i)}
				onBlur={(e) => {
					if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setLifted((cur) => (cur === i ? null : cur));
				}}
			>
				<IconFileOutline16 size={12} style={{ flex: "none", color: "var(--dsw-label-tertiary)" }} />
				<span className="max-w-[110px] truncate font-mono text-[12px]">{f.name}</span>
				<span style={{ flex: "none", fontSize: 10.5, color: "var(--dsw-label-caption)" }}>{fmtUploadSize(f.size)}</span>
				<button
					type="button"
					className="pw-ref-close"
					disabled={disabled}
					onClick={(e) => {
						e.stopPropagation();
						onRemove(i);
						setLifted(null);
					}}
					aria-label={`${t.delete} ${f.name}`}
				>
					✕
				</button>
			</div>
		);
	};

	return (
		<div ref={railRef} className="pointer-events-auto flex flex-wrap items-center gap-1.5 px-1" data-testid="composer-uploads">
			{collapsible ? (
				<div
					className="pw-file-fan-container relative flex items-center gap-2"
					style={{
						position: "relative",
						width: fanned ? layout.width : layout.width + 8,
						height: layout.height,
						transition: "width 320ms cubic-bezier(0.2, 0.8, 0.2, 1), height 320ms cubic-bezier(0.2, 0.8, 0.2, 1)",
					}}
				>
					{files.map((f, i) => renderFileCard(f, i, layout.cards[i], true))}
				</div>
			) : (
				files.map((f, i) => renderFileCard(f, i))
			)}

			{collapsible && (
				<button
					type="button"
					className="pw-chip"
					data-testid="uploads-toggle"
					onClick={() => {
						setExpanded((open) => !open);
						setLifted(null);
					}}
				>
					{expanded ? t.chipCollapse : t.chipExpandMore.replace("{n}", String(files.length - COLLAPSE_AT))}
				</button>
			)}

			{files.length > 1 && onClear && (
				<button
					type="button"
					className="pw-chip"
					data-testid="uploads-clear"
					disabled={disabled}
					onClick={() => {
						onClear();
						setLifted(null);
					}}
				>
					{t.filesClearAll}
				</button>
			)}
		</div>
	);
}
