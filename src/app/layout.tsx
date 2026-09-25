import type { Metadata, Viewport } from "next";
// Maple Mono CN（含中文字形，unicode-range 分片按需加载）—— pebrel 同款字体
import "@automann/maple-mono-cn/regular.css";
import "@automann/maple-mono-cn/medium.css";
import "./globals.css";

export const metadata: Metadata = {
	title: "PiWeb | Workbench",
	description: "A focused workbench for the pi coding agent",
};

export const viewport: Viewport = {
	width: "device-width",
	initialScale: 1,
	themeColor: [
		{ media: "(prefers-color-scheme: light)", color: "#f2f5ee" },
		{ media: "(prefers-color-scheme: dark)", color: "#101816" },
	],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
	return (
		<html lang="zh-CN" data-pebrel-theme="piweb" suppressHydrationWarning>
			<body data-pebrel-theme="piweb" suppressHydrationWarning>
				{children}
			</body>
		</html>
	);
}
