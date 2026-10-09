import { describe, expect, it } from "vitest";
import { promptsFromEntries } from "../../../src/lib/growth/growth-turns";

describe("promptsFromEntries", () => {
	const entries = [
		{ type: "message", id: "old", message: { role: "user", content: "上一轮的提问" } },
		{ type: "message", id: "old-reply", message: { role: "assistant", content: [{ type: "text", text: "好的" }] } },
		{ type: "message", id: "a", message: { role: "user", content: [{ type: "text", text: "\n  把保存按钮改成红色  \n顺便加个图标" }] } },
		{ type: "compaction", id: "compact" },
		{ type: "message", id: "b", message: { role: "user", content: "追加：别动布局" } },
		{ type: "message", id: "reply", message: { role: "assistant", content: [{ type: "text", text: "改好了" }] } },
	];

	it("collects the run's user messages after the start index, titled by the first non-empty line", () => {
		expect(promptsFromEntries(entries, 2)).toEqual({ ids: ["a", "b"], title: "把保存按钮改成红色" });
	});

	it("leaves the title empty for an image-only prompt", () => {
		const imageOnly = [{ type: "message", id: "img", message: { role: "user", content: [{ type: "image", data: "x", mimeType: "image/png" }] } }];
		expect(promptsFromEntries(imageOnly)).toEqual({ ids: ["img"], title: "" });
	});
});
