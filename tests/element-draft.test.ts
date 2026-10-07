import { describe, expect, it } from "vitest";
import { describeElements, type DraftElement } from "@/lib/element-draft";

const t = {
	elementPromptHeader: "页面元素：{label}",
	elementPromptPage: "- 页面：{url}",
	elementPromptPath: "- DOM：{selector}",
	elementPromptSource: "- 源码：{locations}",
	elementPromptComponent: "- 组件：{component}",
	elementPromptImage: "- 截图：第 {n} 张附图",
};

const crop = (data: string) => ({ type: "image" as const, data, mimeType: "image/jpeg" });

function element(overrides: Partial<DraftElement> = {}): DraftElement {
	return {
		key: "k1",
		label: "<button#save> “保存”",
		selector: "main > button#save",
		pageUrl: "http://localhost:5173/settings",
		locations: [{ path: "src/Settings.tsx", line: 42 }, { path: "src/i18n.ts", line: 7 }],
		...overrides,
	};
}

describe("describing picked elements for the prompt", () => {
	it("lists the label, page, DOM path, sources and component as a Markdown list", () => {
		const { text, crops } = describeElements([element({ component: "Settings" })], t);
		expect(text).toBe([
			"页面元素：`<button#save> “保存”`",
			"- 页面：http://localhost:5173/settings",
			"- DOM：`main > button#save`",
			"- 源码：`src/Settings.tsx:42`, `src/i18n.ts:7`",
			"- 组件：`Settings`",
		].join("\n"));
		expect(crops).toEqual([]);
	});

	it("omits empty parts, separates elements with a blank line and never attaches crops for text-only models", () => {
		const bare = element({ selector: "", pageUrl: "", locations: [], crop: crop("A") });
		const { text, crops } = describeElements([bare, { ...bare, key: "k2", label: "<p> “说明”" }], t);
		expect(text).toBe("页面元素：`<button#save> “保存”`\n\n页面元素：`<p> “说明”`");
		expect(crops).toEqual([]);
	});

	it("keeps Markdown-looking page text literal inside code spans", () => {
		const { text } = describeElements([element({ label: "<b> “a `x` *b* _c_”", selector: "div.btn_primary > span", locations: [] })], t);
		expect(text).toContain("页面元素：``<b> “a `x` *b* _c_”``");
		expect(text).toContain("- DOM：`div.btn_primary > span`");
		expect(describeElements([element({ label: "`edge`", locations: [] })], t).text).toContain("页面元素：`` `edge` ``");
	});

	it("numbers attached crops after the user's own images and stops at the limit", () => {
		const elements = [element({ key: "a", crop: crop("A") }), element({ key: "b" }), element({ key: "c", crop: crop("C") }), element({ key: "d", crop: crop("D") })];
		const { text, crops } = describeElements(elements, t, { firstNumber: 3, max: 2 });
		expect(crops.map((image) => image.data)).toEqual(["A", "C"]);
		expect(text.match(/截图：第 \d 张附图/g)).toEqual(["截图：第 3 张附图", "截图：第 4 张附图"]);
	});

	it("inserts page text literally even when it looks like a replacement pattern", () => {
		const { text } = describeElements([element({ label: "<span> “$& $1 $$”", locations: [] })], t);
		expect(text).toContain("<span> “$& $1 $$”");
	});
});
