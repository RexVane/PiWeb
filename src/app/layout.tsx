import type { Metadata, Viewport } from "next";
import "./globals.css";
import { cookies } from "next/headers";
import { I18nProvider } from "@/i18n";

export const metadata: Metadata = {
	title: "pi",
	description: "Web UI for the pi coding agent",
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
	const initialLang = savedLanguage === "en" || savedLanguage === "zh" ? savedLanguage : undefined;
	const language = initialLang === "en" ? "en" : "zh-CN";
	return (
		<html lang={language} suppressHydrationWarning>
			<head><script dangerouslySetInnerHTML={{ __html: `(function(){try{var r=document.documentElement;var m=localStorage.getItem("piweb.theme");var d=true;if(m==="light")d=false;else if(m==="system")d=matchMedia("(prefers-color-scheme: dark)").matches;else if(m&&m!=="dark")localStorage.setItem("piweb.theme","dark");r.setAttribute(d?"data-ds-dark-theme":"data-ds-light-theme","");r.style.colorScheme=d?"dark":"light";var p=localStorage.getItem("piweb.pebrelTheme");if(p==="dsh")return;if(p==="ripple"||p==="dawn"||p==="nord-paper")r.setAttribute("data-pebrel-theme",p);else{if(p)localStorage.setItem("piweb.pebrelTheme","nord-paper");r.setAttribute("data-pebrel-theme","nord-paper");}}catch(e){}})();` }} /></head>
			<body suppressHydrationWarning>
				<I18nProvider initialLang={initialLang}>{children}</I18nProvider>
			</body>
		</html>
	);
}
