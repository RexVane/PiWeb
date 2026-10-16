/**
 * Iconsax 风格 PiMark（微曲圆角矢量 π 徽标）+ 现代品牌簇（PiWeb）
 */
"use client";

export function PiMark({
	size = 20,
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
			viewBox="0 0 24 24"
			fill="none"
			aria-hidden
			className={className}
			style={{ display: "block", flex: "none", ...style }}
		>
			<defs>
				<linearGradient id="isx-pi-grad" x1="0%" y1="0%" x2="100%" y2="100%">
					<stop offset="0%" stopColor="#02defc" />
					<stop offset="50%" stopColor="#7ffe00" />
					<stop offset="100%" stopColor="#fc0197" />
				</linearGradient>
			</defs>
			{/* 现代圆角 π 字符造型：水平顶梁与双流线支腿 */}
			<path
				d="M3.75 6.75C3.75 5.92 4.42 5.25 5.25 5.25H18.75C19.58 5.25 20.25 5.92 20.25 6.75C20.25 7.58 19.58 8.25 18.75 8.25H5.25C4.42 8.25 3.75 7.58 3.75 6.75Z"
				fill="currentColor"
			/>
			<path
				d="M8.25 7.5V15.5C8.25 17.16 6.91 18.5 5.25 18.5C4.42 18.5 3.75 17.83 3.75 17C3.75 16.17 4.42 15.5 5.25 15.5C5.66 15.5 6 15.16 6 14.75V7.5H8.25Z"
				fill="currentColor"
			/>
			<path
				d="M15 7.5V14.5C15 15.88 16.12 17 17.5 17C18.33 17 19 17.67 19 18.5C19 19.33 18.33 20 17.5 20C14.46 20 12.75 17.54 12.75 14.5V7.5H15Z"
				fill="currentColor"
			/>
		</svg>
	);
}

/** 品牌簇：Iconsax 风格 Squircle 徽标 + 渐变品牌字 */
export function BrandPi({ compact = false }: { compact?: boolean }) {
	if (compact) {
		return (
			<div
				className="flex items-center justify-center rounded-[10px] border border-white/10 transition-transform duration-200 hover:scale-105"
				style={{
					width: 32,
					height: 32,
					background: "var(--dsw-bg-elevated)",
					boxShadow: "0 2px 8px rgba(0,0,0,0.18)",
				}}
			>
				<PiMark size={18} style={{ color: "var(--dsw-label-primary)" }} />
			</div>
		);
	}
	return (
		<div
			className="group inline-flex cursor-pointer select-none items-center gap-2.5 transition-transform duration-200"
			style={{ color: "var(--dsw-label-primary)" }}
		>
			{/* Iconsax 风格圆角微光徽标盒 */}
			<div
				className="relative flex items-center justify-center rounded-[9px] border transition-all duration-300 group-hover:scale-105"
				style={{
					width: 28,
					height: 28,
					background: "var(--dsw-bg-elevated)",
					borderColor: "var(--dsw-border-l3)",
					boxShadow: "0 2px 10px rgba(0,0,0,0.12)",
				}}
			>
				<PiMark size={16} style={{ color: "var(--dsw-label-primary)" }} />
			</div>

			{/* 品牌名称：Pi (高反差主色) + Web (Iconsax 彩虹渐变字) */}
			<div className="flex items-baseline gap-0.5">
				<span
					style={{
						fontSize: 16.5,
						fontWeight: 700,
						letterSpacing: "-0.03em",
						color: "var(--dsw-label-primary)",
						lineHeight: 1,
					}}
				>
					Pi
				</span>
				<span
					style={{
						fontSize: 16.5,
						fontWeight: 600,
						letterSpacing: "-0.02em",
						background: "var(--isx-line-gradient)",
						WebkitBackgroundClip: "text",
						WebkitTextFillColor: "transparent",
						lineHeight: 1,
					}}
				>
					Web
				</span>
			</div>
		</div>
	);
}
