import type { Metadata, Viewport } from "next";
// Maple Mono CN（含中文字形，unicode-range 分片按需加载）—— pebrel 同款字体
import "@automann/maple-mono-cn/regular.css";
import "@automann/maple-mono-cn/medium.css";
import "./globals.css";

export const metadata: Metadata = {
	title: "pi",
	description: "Web UI for the pi coding agent",
};

export const viewport: Viewport = {
	width: "device-width",
	initialScale: 1,
	themeColor: [
		{ media: "(prefers-color-scheme: light)", color: "#fcfbf9" },
		{ media: "(prefers-color-scheme: dark)", color: "#2e3440" },
	],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
	return (
		<html lang="zh-CN" suppressHydrationWarning>
			<body suppressHydrationWarning>
				{children}
			</body>
		</html>
	);
}
