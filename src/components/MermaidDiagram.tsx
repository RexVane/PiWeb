"use client";

import { memo, useContext, useEffect, useLayoutEffect, useState } from "react";
import { ChatScrollContext } from "@/components/chat/chat-scroll";
import { mermaidImageUrl, renderMermaid, type MermaidImage } from "@/lib/mermaid";
import { useI18n } from "@/i18n";

export const MermaidDiagram = memo(function MermaidDiagram({ source }: { source: string }) {
	const { t } = useI18n();
	const scroll = useContext(ChatScrollContext);
	const [result, setResult] = useState<{ source: string; image?: MermaidImage; failed?: boolean } | null>(null);
	const current = result?.source === source ? result : null;
	const image = current?.image;
	useEffect(() => {
		let active = true;
		void renderMermaid(source).then(
			(image) => { if (active) setResult({ source, image }); },
			() => { if (active) setResult({ source, failed: true }); },
		);
		return () => { active = false; };
	}, [source]);
	useLayoutEffect(() => { if (scroll?.shouldPin()) scroll.pin(); }, [image, current?.failed, scroll]);
	return (
		<div className="md-diagram">
			{!current && <div className="md-diagram-status" role="status">{t.diagramLoading}</div>}
			{current?.failed && <>
				<div className="md-diagram-status" role="status">{t.diagramFailed}</div>
				<pre><code className="language-mermaid">{source}</code></pre>
			</>}
			{image && <>
				{/* A static image cannot bind Mermaid callbacks or execute SVG scripts in the page. */}
				{/* eslint-disable-next-line @next/next/no-img-element */}
				<img src={mermaidImageUrl(image)} width={image.width} height={image.height} alt={t.diagramTitle} draggable={false} />
			</>}
		</div>
	);
});
