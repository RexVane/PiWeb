// @vitest-environment jsdom
import { act } from "react";
import { renderToString } from "react-dom/server";
import { hydrateRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider, useI18n } from "@/i18n";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Notice() { const { t } = useI18n(); return <span>{t.stop}</span>; }
afterEach(() => { document.body.replaceChildren(); localStorage.clear(); document.documentElement.lang = "zh-CN"; });
describe("server locale hydration", () => {
	it("uses the serialized cookie locale even when browser language and storage differ", async () => {
		localStorage.setItem("piweb.lang", "zh"); document.documentElement.lang = "zh-CN";
		const tree = <I18nProvider initialLang="en"><I18nProvider><Notice /></I18nProvider></I18nProvider>;
		const container = document.createElement("div"); container.innerHTML = renderToString(tree); document.body.append(container);
		expect(container.textContent).toBe("Stop");
		const recovered: unknown[] = [];
		let root!: ReturnType<typeof hydrateRoot>;
		await act(async () => { root = hydrateRoot(container, tree, { onRecoverableError: (error) => recovered.push(error) }); });
		expect(recovered).toEqual([]); expect(container.textContent).toBe("Stop"); expect(document.documentElement.lang).toBe("en");
		await act(async () => root.unmount());
	});
	it("migrates legacy browser preferences after hydration when no cookie exists", async () => {
		localStorage.setItem("piweb.lang", "en");
		const tree = <I18nProvider><Notice /></I18nProvider>;
		const container = document.createElement("div"); container.innerHTML = renderToString(tree); document.body.append(container);
		expect(container.textContent).toBe("停止");
		const recovered: unknown[] = [];
		let root!: ReturnType<typeof hydrateRoot>;
		await act(async () => { root = hydrateRoot(container, tree, { onRecoverableError: (error) => recovered.push(error) }); });
		expect(recovered).toEqual([]); expect(container.textContent).toBe("Stop"); expect(document.cookie).toContain("piweb.lang=en");
		await act(async () => root.unmount());
	});
});
