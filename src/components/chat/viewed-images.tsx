"use client";

import { memo, useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";
import { IconChevronRight14 } from "@/components/icons";
import { ImageViewer, imageSource } from "@/components/ImageViewer";
import { useI18n } from "@/i18n";
import { relativizePath } from "@/lib/process-format";
import type { ViewedImagePreview } from "@/lib/chat/tool-images";

/** 过程图片默认只显示计数；展开后才加载缩略图，大图复用只读图集。 */
export const ViewedImages = memo(function ViewedImages({ images, cwd, onOpenFile }: {
	images: ViewedImagePreview[];
	cwd?: string;
	onOpenFile?: (path: string) => void;
}) {
	const { t } = useI18n();
	const [open, setOpen] = useState(false);
	const [selected, setSelected] = useState<{ id: string; source: string } | null>(null);
	const galleryId = useId();
	const index = selected ? images.findIndex((entry) => entry.id === selected.id && imageSource(entry.image) === selected.source) : -1;
	// 流式追加其它图片时保留当前页；所选图片被替换/移除时关闭，不跳到另一张。
	useEffect(() => {
		if (selected && index < 0) setSelected(null);
	}, [selected, index]);
	if (!images.length) return null;
	const select = (at: number) => setSelected({ id: images[at].id, source: imageSource(images[at].image) });
	return (
		<div className="pw-viewed-images">
			<button
				type="button"
				className="pw-line pw-clickable"
				aria-expanded={open}
				aria-controls={galleryId}
				title={open ? t.imagesCollapse : t.imagesExpand}
				onClick={() => { setOpen((value) => !value); setSelected(null); }}
			>
				<span className="pw-gist">{images.length === 1 ? t.imagesViewed1 : t.imagesViewed.replace("{n}", String(images.length))}</span>
				<IconChevronRight14 size={12} className="pw-chev" aria-hidden="true" />
			</button>
			{open && (
				<div id={galleryId} className="pw-viewed-image-grid">
					{images.map((entry, at) => {
						const label = entry.path ? relativizePath(entry.path, cwd) : `#${at + 1}`;
						const source = imageSource(entry.image);
						return (
							<figure key={entry.id} className="pw-viewed-image">
								<button type="button" className="pw-viewed-image-open" disabled={!source} aria-label={`${t.imagePreview}: ${label}`} onClick={() => select(at)}>
									<img src={source || undefined} alt={label} width={112} height={80} loading="lazy" decoding="async" draggable={false} />
								</button>
								<figcaption title={entry.path}>
									{entry.path && onOpenFile ? (
										<button type="button" className="pw-viewed-image-file" onClick={() => onOpenFile(entry.path!)}>{label}</button>
									) : label}
								</figcaption>
							</figure>
						);
					})}
				</div>
			)}
			{index >= 0 && createPortal(
				<ImageViewer images={images.map((entry) => entry.image)} index={index} onIndex={select} onClose={() => setSelected(null)} />,
				document.body,
			)}
		</div>
	);
});
