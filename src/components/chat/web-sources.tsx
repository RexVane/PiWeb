"use client";

import { useState } from "react";
import { IconChevronRight14, IconExternalLink12, IconGitOutline16 } from "@/components/icons";
import { useI18n } from "@/i18n";
import { formatWebUrlLabel, isPublicFaviconHost, topWebDomains, type WebSource } from "@/lib/web-search";

const BADGE_TONES = [
	{ bg: "#e8eefc", fg: "#2855b8", darkBg: "#213152", darkFg: "#9ec0ff" },
	{ bg: "#e4f4eb", fg: "#166e46", darkBg: "#1a3c2d", darkFg: "#7fdcae" },
	{ bg: "#fae8ea", fg: "#a82d3f", darkBg: "#49212a", darkFg: "#ffa1ad" },
	{ bg: "#f5ecdf", fg: "#8f5414", darkBg: "#44321c", darkFg: "#f5c27a" },
	{ bg: "#efe8fa", fg: "#6035a8", darkBg: "#31234a", darkFg: "#cbb2ff" },
	{ bg: "#e4f2f7", fg: "#15637d", darkBg: "#193845", darkFg: "#8ad4ed" },
] as const;

function domainHash(domain: string): number {
	let h = 0;
	for (let i = 0; i < domain.length; i += 1) h = (h * 31 + domain.charCodeAt(i)) >>> 0;
	return h;
}

function monogramOf(domain: string): string {
	const cleaned = domain.replace(/^www\./, "");
	const ch = cleaned.match(/[a-zA-Z0-9\u4e00-\u9fff]/)?.[0] ?? "?";
	return ch.toUpperCase();
}

function isGitHubDomain(domain: string): boolean {
	return (
		domain === "github.com" ||
		domain === "gist.github.com" ||
		domain === "raw.githubusercontent.com" ||
		domain.endsWith(".github.io")
	);
}

/** 站点圆形徽标：GitHub 内置矢量标，其余带确定性底色首字母 + 可选公网 favicon 渐进叠加 */
export function SiteFavicon({ domain, size = 15 }: { domain: string; size?: number }) {
	const [loaded, setLoaded] = useState(false);
	const [failed, setFailed] = useState(false);
	const tone = BADGE_TONES[domainHash(domain) % BADGE_TONES.length];
	const github = isGitHubDomain(domain);
	const canFetchIcon = !github && !failed && isPublicFaviconHost(domain);

	return (
		<span
			className="pw-favicon"
			title={domain}
			data-github={github || undefined}
			data-loaded={loaded || undefined}
			style={{
				width: size,
				height: size,
				fontSize: Math.max(8, Math.round(size * 0.56)),
				["--pw-fav-bg" as string]: tone.bg,
				["--pw-fav-fg" as string]: tone.fg,
				["--pw-fav-bg-dark" as string]: tone.darkBg,
				["--pw-fav-fg-dark" as string]: tone.darkFg,
			}}
		>
			{github ? (
				<IconGitOutline16 size={Math.max(10, Math.round(size * 0.86))} />
			) : (
				<>
					<span className="pw-favicon-letter">{monogramOf(domain)}</span>
					{canFetchIcon && (
						<img
							src={`https://${domain}/favicon.ico`}
							alt=""
							width={size}
							height={size}
							loading="lazy"
							referrerPolicy="no-referrer"
							className="pw-favicon-img"
							style={{ opacity: loaded ? 1 : 0 }}
							onLoad={() => setLoaded(true)}
							onError={() => setFailed(true)}
						/>
					)}
				</>
			)}
		</span>
	);
}

/** 堆叠站点图标（对齐截图样式） */
export function FaviconStack({ domains, size = 15, max = 4 }: { domains: string[]; size?: number; max?: number }) {
	const list = domains.slice(0, max);
	if (list.length === 0) return null;
	return (
		<span className="pw-favicon-stack" aria-hidden="true">
			{list.map((domain) => (
				<SiteFavicon key={domain} domain={domain} size={size} />
			))}
		</span>
	);
}

/** 可点击「堆叠图标 + N 个来源」触发胶囊：展开或收起可点击外链列表 */
export function WebSourcesTrigger({
	sources,
	expanded,
	onToggle,
	showChevron = true,
}: {
	sources: WebSource[];
	expanded: boolean;
	onToggle: () => void;
	showChevron?: boolean;
}) {
	const { t } = useI18n();
	if (sources.length === 0) return null;
	const domains = topWebDomains(sources, 4);
	const countText = (sources.length === 1 ? t.webSourcesCount1 : t.webSourcesCount).replace("{n}", String(sources.length));
	const title = expanded ? t.webSourcesHide : t.webSourcesShow.replace("{n}", String(sources.length));

	return (
		<button
			type="button"
			className="pw-web-sources-trigger"
			aria-expanded={expanded}
			title={title}
			aria-label={`${domains.slice(0, 3).join(", ")} · ${countText}`}
			onClick={(e) => {
				e.stopPropagation();
				onToggle();
			}}
		>
			<FaviconStack domains={domains} size={15} max={4} />
			<span className="pw-web-sources-count">{countText}</span>
			{showChevron && <IconChevronRight14 size={11} className="pw-web-sources-chev" />}
		</button>
	);
}

/** 展开的联网来源列表：每条均可直接点击在新标签页打开对应网页 */
export function WebSourcesPanel({
	sources,
	className,
	rawToggle,
}: {
	sources: WebSource[];
	className?: string;
	rawToggle?: { open: boolean; onToggle: () => void };
}) {
	const { t } = useI18n();
	if (sources.length === 0) return null;
	const regionLabel = (sources.length === 1 ? t.webSourcesCount1 : t.webSourcesCount).replace("{n}", String(sources.length));

	return (
		<div className={className ? `pw-web-sources ${className}` : "pw-web-sources"} role="region" aria-label={regionLabel}>
			<div className="pw-web-sources-list">
				{sources.map((src) => {
					const pathLabel = formatWebUrlLabel(src.url);
					return (
						<a
							key={src.url}
							href={src.url}
							target="_blank"
							rel="noopener noreferrer"
							className="pw-web-source-item"
							title={src.url}
						>
							<SiteFavicon domain={src.domain} size={15} />
							<span className="pw-web-source-meta">
								<span className="pw-web-source-title">{src.title || pathLabel}</span>
								<span className="pw-web-source-url">{src.title ? pathLabel : src.domain}</span>
							</span>
							<IconExternalLink12 size={11} className="pw-web-source-ext" aria-hidden="true" />
						</a>
					);
				})}
			</div>
			{rawToggle && (
				<div className="pw-web-sources-foot">
					<button
						type="button"
						className="pw-web-raw-btn"
						aria-expanded={rawToggle.open}
						onClick={rawToggle.onToggle}
					>
						{rawToggle.open ? t.webRawOutputHide : t.webRawOutputShow}
					</button>
				</div>
			)}
		</div>
	);
}
