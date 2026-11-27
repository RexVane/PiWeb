"use client";

import { useId, useRef } from "react";
import { createPortal } from "react-dom";
import Image from "next/image";
import { useDialog } from "@/hooks/useDialog";
import { useI18n } from "@/i18n";
import { overviewSourceKey, type OverviewSource, type SourceOrigin, type overviewSources } from "@/lib/overview-sources";
import { imageSource } from "./ImageViewer";
import { IconCloseOutline14, IconExternalLink12, IconFileOutline16, IconGitOutline16, IconGlobeOutline14 } from "./icons";
import styles from "./ProjectOverview.module.css";

type LocalSource = Exclude<OverviewSource, { kind: "link" }>;
type SourceCollection = ReturnType<typeof overviewSources>;
const originKeys = {
	draft: "overviewOriginDraft", attached: "overviewOriginAttached", provided: "overviewOriginProvided",
	read: "overviewOriginRead", found: "overviewOriginFound", mentioned: "overviewOriginMentioned",
} as const satisfies Record<SourceOrigin, string>;

export function OverviewSourceRow({ source, index, cwd, detailed = false, onOpen }: {
	source: OverviewSource; index: number; cwd: string; detailed?: boolean; onOpen: (source: LocalSource) => void;
}) {
	const { t } = useI18n();
	const link = source.kind === "link" ? source.url : undefined;
	const github = link && new URL(link).hostname === "github.com";
	const thumbnail = source.kind === "image" && imageSource(source.image);
	const label = source.kind === "image" ? source.image.name || t.overviewImage.replace("{n}", String(index + 1)) : source.label;
	let location = source.kind === "image" ? source.image.mimeType : source.kind === "link" ? source.url : source.path;
	if (source.kind === "file" && cwd && !/^(?:[/\\]|[a-z]:[/\\])/i.test(location)) {
		const separator = cwd.includes("\\") ? "\\" : "/";
		location = cwd.replace(/[/\\]+$/, "") + separator + location.replace(/[/\\]/g, separator);
	}
	const content = <>
		{thumbnail ? <Image src={thumbnail} alt="" width={18} height={18} unoptimized /> : github ? <IconGitOutline16 /> : link ? <IconGlobeOutline14 /> : <IconFileOutline16 />}
		<span className={styles.sourceText}>
			<span className={styles.sourceName}>{label}</span>
			{detailed && <>
				<span className={styles.location}>{github ? "GitHub · " : ""}{location}</span>
				<span className={styles.origin}>{source.origins.map((origin) => t[originKeys[origin]]).join(" · ")}</span>
			</>}
		</span>
		{link && !detailed && <IconExternalLink12 className={styles.external} />}
	</>;
	return <li>{source.kind === "link"
		? <a className={styles.source} href={source.url} target="_blank" rel="noopener noreferrer" title={source.url}>{content}</a>
		: <button className={styles.source} type="button" onClick={() => onOpen(source)} title={location}>{content}</button>}
	</li>;
}

export function OverviewSourcesDialog({ collection, cwd, hasEarlier, loadingEarlier, onLoadEarlier, onClose, onOpen }: {
	collection: SourceCollection; cwd: string; hasEarlier: boolean; loadingEarlier: boolean; onLoadEarlier: () => void;
	onClose: () => void; onOpen: (source: LocalSource) => void;
}) {
	const { t } = useI18n();
	const titleId = useId();
	const dialog = useRef<HTMLElement>(null);
	useDialog({ open: true, ref: dialog, onClose });
	return createPortal(<div data-overview-sources="" className={styles.scrim} onPointerDown={(event) => {
		if (event.target === event.currentTarget) onClose();
	}}>
		<section ref={dialog} className={styles.detail} role="dialog" aria-modal="true" aria-labelledby={titleId}>
			<header className={styles.detailHeader}>
				<h2 id={titleId}>{t.overviewSources}</h2>
				<button type="button" className="icon-btn" aria-label={t.close} onClick={onClose}><IconCloseOutline14 /></button>
			</header>
			<div className={styles.detailBody}>
				<ul className={styles.sources}>{collection.sources.map((source, index) =>
					<OverviewSourceRow key={overviewSourceKey(source)} source={source} index={index} cwd={cwd} detailed onOpen={onOpen} />
				)}</ul>
				{(collection.searches > 0 || collection.opened > 0) && <div className={styles.webActivity}>
					<IconGlobeOutline14 /><div><strong>{t.overviewWebActivity}</strong>
						<p>{t.overviewSearches.replace("{n}", String(collection.searches))}</p>
						<p>{t.overviewOpenedPages.replace("{n}", String(collection.opened))}</p>
					</div>
				</div>}
				{hasEarlier && <button type="button" className={styles.more} disabled={loadingEarlier} onClick={onLoadEarlier}>
					{loadingEarlier ? t.loadingEarlierMessages : t.overviewEarlier}
				</button>}
			</div>
		</section>
	</div>, document.body);
}
