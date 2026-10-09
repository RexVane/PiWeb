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
		return <PiMark size={18} />;
	}
	return (
		<div
			className="inline-flex items-center select-none"
			style={{
				color: "var(--dsw-label-primary)",
				gap: 6,
			}}
		>
			<PiMark size={17} />
			<span
				className="inline-flex items-center"
				style={{
					fontSize: 16.5,
					fontWeight: 600,
					letterSpacing: "-0.02em",
					color: "var(--dsw-label-primary)",
					lineHeight: 1,
				}}
			>
				pi
			</span>
			<span
				className="inline-flex items-center justify-center font-bold"
				style={{
					fontSize: 9.5,
					letterSpacing: "0.06em",
					height: 15,
					paddingLeft: 4.5,
					paddingRight: 4.5,
					borderRadius: 4,
					background: "var(--dsw-label-primary)",
					color: "var(--dsw-bg-base)",
					lineHeight: 1,
					textTransform: "uppercase",
				}}
			>
				HARNESS
			</span>
		</div>
	);
}
