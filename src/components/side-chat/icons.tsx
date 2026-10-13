import type { SVGProps } from "react";

export function SideChatIcon({ size = 16, ...props }: SVGProps<SVGSVGElement> & { size?: number }) {
	return <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
		<path d="M12.5 11.5H6l-3.5 2V4.5A2 2 0 0 1 4.5 2.5h8a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2Z" />
		<path d="M7.5 14.5h6.5l3.5 2V7.5a2 2 0 0 0-1-1.73" />
	</svg>;
}
