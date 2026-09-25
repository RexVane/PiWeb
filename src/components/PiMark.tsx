/**
 * 官方 π mark（取自 pi.dev favicon，currentColor 化）+ dsh BrandWordmark 式品牌簇。
 */
"use client";

export function PiMark({
	size = 18,
	className,
	style,
}: {
	size?: number;
	className?: string;
	style?: React.CSSProperties;
}) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="165.29 165.29 469.43 469.43"
			aria-hidden
			className={className}
			style={{ color: "var(--dsw-label-primary)", display: "block", flex: "none", ...style }}
		>
			<path
				fill="currentColor"
				fillRule="evenodd"
				d="M165.29 165.29 H517.36 V400 H400 V517.36 H282.65 V634.72 H165.29 Z M282.65 282.65 V400 H400 V282.65 Z"
			/>
			<path fill="currentColor" d="M517.36 400 H634.72 V634.72 H517.36 Z" />
		</svg>
	);
}

/** 品牌簇：对齐 dsh 品牌模板 [Logo] [Name] [BADGE] */
export function BrandPi({ compact = false }: { compact?: boolean }) {
	if (compact) {
		return <PiMark size={18} style={{ color: "var(--dsw-accent)" }} />;
	}
	return (
		<div className="pw-brand select-none">
			<span className="pw-brand-symbol"><PiMark size={18} style={{ color: "var(--dsw-accent)" }} /></span>
			<span className="pw-brand-name">piweb</span>
			<span className="pw-brand-meta">CODE WORKBENCH</span>
		</div>
	);
}
