"use client";

import { useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { ImageViewer, imageSource, type PreviewImageSource } from "@/components/ImageViewer";
import { useI18n } from "@/i18n";

/** A chat image opens a read-only gallery without changing or deleting persisted messages. */
export function PreviewImage({ image, images = [image], index = 0, alt = "", title, className, style }: {
	image: PreviewImageSource;
	images?: PreviewImageSource[];
	index?: number;
	alt?: string;
	title?: string;
	className?: string;
	style?: CSSProperties;
}) {
	const { t } = useI18n();
	const [preview, setPreview] = useState<number | null>(null);
	return <>
		<button type="button" className="pw-chat-image-preview" title={title ?? t.imagePreview} aria-label={alt ? `${t.imagePreview}: ${alt}` : t.imagePreview} onClick={(event) => {
			event.preventDefault();
			event.stopPropagation();
			setPreview(index);
		}}>
			<img src={imageSource(image)} alt={alt} title={title} className={className} style={style} draggable={false} />
		</button>
		{preview !== null && images[preview] && createPortal(
			<ImageViewer images={images} index={preview} onIndex={setPreview} onClose={() => setPreview(null)} />,
			document.body,
		)}
	</>;
}
