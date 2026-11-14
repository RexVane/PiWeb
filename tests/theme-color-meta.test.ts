// @vitest-environment jsdom
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyPebrelTheme } from "@/lib/theme";

afterEach(() => {
	document.head.innerHTML = "";
	document.documentElement.removeAttribute("data-pebrel-theme");
	document.documentElement.removeAttribute("data-ds-dark-theme");
	document.documentElement.removeAttribute("data-ds-light-theme");
	localStorage.clear();
});

describe("themeColor meta sync & CSS token integrity", () => {
	it("updates existing theme-color meta tags when applying light/dark themes", () => {
		document.head.innerHTML = `
			<meta name="theme-color" media="(prefers-color-scheme: light)" content="#fcfbf9" />
			<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#2e3440" />
		`;
		applyPebrelTheme("dsh", "dark");
		const metas = Array.from(document.head.querySelectorAll('meta[name="theme-color"]'));
		expect(metas.map((m) => m.getAttribute("content"))).toEqual(["#09090c", "#09090c"]);

		applyPebrelTheme("dsh", "light");
		expect(metas.map((m) => m.getAttribute("content"))).toEqual(["#ffffff", "#ffffff"]);
	});

	it("keeps CSS token definitions clean and free of undefined legacy tokens", () => {
		const css = fs.readFileSync(path.join(process.cwd(), "src/app/globals.css"), "utf8");
		expect(css).toContain("--piweb-chat-line-height:");
		expect(css).not.toContain("--dsw-surface-l1");
		expect(css).not.toContain("--dsw-warning");
		expect(css).not.toContain("--dsw-markdown-code-block");
	});
});
