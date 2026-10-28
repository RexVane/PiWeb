"use client";

import { useEffect, useRef } from "react";
import { useI18n } from "@/i18n";
import type { ImageAttachment } from "@/lib/types";
import { useDialog } from "@/hooks/useDialog";

export type PreviewImageSource = ImageAttachment | string;
export const imageSource = (image: PreviewImageSource) => typeof image === "string" ? image : `data:${image.mimeType};base64,${image.data}`;

/** 只读图集；删除只提供给尚未发送的输入附件（发出去的消息图片不可删） */
export function ImageViewer({ images, index, disabled, onIndex, onRemove, onClose }: {
	images: PreviewImageSource[];
	index: number;
	disabled?: boolean;
	onIndex: (index: number) => void;
	onRemove?: (index: number) => void;
	onClose: () => void;
}) {
	const { t } = useI18n();
	const dialogRef = useRef<HTMLDivElement>(null);
	const closeRef = useRef<HTMLButtonElement>(null);
	useDialog({ open: Boolean(images[index]), onClose, ref: dialogRef });
	const count = images.length;
	const go = (delta: number) => onIndex((index + delta + count) % count);

	// 打开时把焦点移进来、锁住页面滚动，关掉时把焦点还给原来那个元素（还在页面上的话）
	useEffect(() => {
		const overflow = document.body.style.overflow;
		document.body.style.overflow = "hidden";
		closeRef.current?.focus();
		return () => {
			document.body.style.overflow = overflow;
		};
	}, []);

	// Escape / 焦点约束由公共弹窗堆栈处理；这里只处理当前光箱内的翻页键。
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			const target = event.target === document ? document.activeElement : event.target;
			if (event.defaultPrevented || event.isComposing || !dialogRef.current?.contains(target as Node)) return;
			if (event.key === "ArrowLeft" && count > 1) go(-1);
			else if (event.key === "ArrowRight" && count > 1) go(1);
			else return;
			event.preventDefault();
			event.stopPropagation();
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [count, index, onClose, onIndex]);

	if (!images[index]) return null;
	return (
		<div ref={dialogRef} className="pw-lightbox" role="dialog" aria-modal="true" aria-label={t.imageViewer} tabIndex={-1} onClick={onClose}>
			<div className="pw-lightbox-bar" onClick={(event) => event.stopPropagation()}>
				<span className="pw-lightbox-count">{count > 1 ? `${index + 1} / ${count}` : ""}</span>
				{onRemove && <button type="button" className="pw-lightbox-btn" disabled={disabled} onClick={() => onRemove(index)}>{t.delete}</button>}
				<button ref={closeRef} type="button" className="pw-lightbox-btn" aria-label={t.close} onClick={onClose}>✕</button>
			</div>
			<img src={imageSource(images[index])} alt={t.imageViewer} className="pw-lightbox-image" onClick={(event) => event.stopPropagation()} />
			{count > 1 && <>
				<button type="button" className="pw-lightbox-nav" data-side="prev" aria-label={t.imagePrev} onClick={(event) => { event.stopPropagation(); go(-1); }}>‹</button>
				<button type="button" className="pw-lightbox-nav" data-side="next" aria-label={t.imageNext} onClick={(event) => { event.stopPropagation(); go(1); }}>›</button>
			</>}
		</div>
	);
}
