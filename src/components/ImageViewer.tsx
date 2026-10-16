"use client";

import { useEffect, useRef } from "react";
import { useI18n } from "@/i18n";
import type { ImageAttachment } from "@/lib/types";

export type PreviewImageSource = ImageAttachment | string;
export const imageSource = (image: PreviewImageSource) => typeof image === "string" ? image : `data:${image.mimeType};base64,${image.data}`;

/** Shared read-only gallery; deletion is offered only for unsent composer attachments. */
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
	const count = images.length;
	const go = (delta: number) => onIndex((index + delta + count) % count);

	useEffect(() => {
		const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		const overflow = document.body.style.overflow;
		document.body.style.overflow = "hidden";
		closeRef.current?.focus();
		return () => {
			document.body.style.overflow = overflow;
			if (opener?.isConnected) opener.focus();
		};
	}, []);

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
	}, [count, index, onClose, onIndex]);

	if (!images[index]) return null;
	return (
		<div ref={dialogRef} className="pw-lightbox" role="dialog" aria-modal="true" aria-label={t.imageViewer} onClick={onClose}>
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
