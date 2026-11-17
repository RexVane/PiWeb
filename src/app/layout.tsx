import type { Metadata, Viewport } from "next";
import "./globals.css";
import { cookies } from "next/headers";
import { I18nProvider } from "@/i18n";
import { htmlLangOf, isLang } from "@/lib/lang";
import { SmoothCaret } from "@/components/SmoothCaret";

export const metadata: Metadata = {
	title: "PiWeb | Pi Coding Agent Web UI",
	description: "Self-hosted web UI for Pi Coding Agent: AI coding in your browser with workspaces, file diffs, MCP, session import and mobile access.",
	applicationName: "PiWeb",
};

export const viewport: Viewport = {
	width: "device-width",
	initialScale: 1,
	viewportFit: "cover",
	interactiveWidget: "resizes-content",
	themeColor: "#2e3440",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
	const preferences = await cookies();
	const savedLanguage = preferences.get("piweb.lang")?.value;
	const initialLang = isLang(savedLanguage) ? savedLanguage : undefined;
	const language = htmlLangOf(initialLang ?? "zh");
	return (
		<html lang={language} suppressHydrationWarning>
			<head><script dangerouslySetInnerHTML={{ __html: `(function(){try{var r=document.documentElement;var m=localStorage.getItem("piweb.theme");var d=true;if(m==="light")d=false;else if(m==="system")d=matchMedia("(prefers-color-scheme: dark)").matches;else if(m&&m!=="dark")localStorage.setItem("piweb.theme","dark");r.setAttribute(d?"data-ds-dark-theme":"data-ds-light-theme","");r.style.colorScheme=d?"dark":"light";var p=localStorage.getItem("piweb.pebrelTheme");if(p==="dsh")return;if(p==="ripple"||p==="dawn"||p==="nord-paper")r.setAttribute("data-pebrel-theme",p);else{if(p)localStorage.setItem("piweb.pebrelTheme","nord-paper");r.setAttribute("data-pebrel-theme","nord-paper");}}catch(e){}})();` }} /></head>
			<body suppressHydrationWarning>
				<I18nProvider initialLang={initialLang}>{children}</I18nProvider>
				{/* 全局滑行光标：所有文本输入框共用这一个 */}
				<SmoothCaret />
			</body>
		</html>
	);
}
