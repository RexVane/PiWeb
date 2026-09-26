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
			<head>
				<link rel="preconnect" href="https://fonts.googleapis.com" />
				<link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
				<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet" />
				<link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200" rel="stylesheet" />
				<link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&display=swap" rel="stylesheet" />
			</head>
			<body className="bg-clay-bg font-sans text-clay-slate-text antialiased h-screen flex flex-col overflow-hidden" data-pebrel-theme="piweb" suppressHydrationWarning>
				{children}
			</body>
		</html>
	);
}
