// @vitest-environment jsdom
/**
 * 输入卡的 chip 显示：
 * - 引用：只取 basename 时目录和同名文件分不清（`src/lib` 与 `src/lib.ts`；`a/index.ts` 与 `b/index.ts`），
 *   所以目录带尾斜杠、其余保留尾部两段；
 * - 图片：以前是 56px 的 object-cover（裁成方形），贴了截图看不出是哪张，也点不开，
 *   现在不裁切、可点开放大、Esc 关闭。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ChatInput, type ChatDraft } from "@/components/ChatInput";

afterEach(cleanup);

function renderInput(initialDraft: Partial<ChatDraft>) {
	render(
		<ChatInput
			isStreaming={false}
			model={{ provider: "test", id: "test-model", name: "Test Model" }}
			contextPercent={null} contextTokens={null} contextWindow={null}
			thinkingLevels={[]} models={[]} providerNames={{}} authByProvider={{}}
			queue={{ steering: [], followUp: [] }}
			initialDraft={{ text: "", images: [], uploads: [], references: [], ...initialDraft }}
			onSend={vi.fn(async () => ({ success: true }))}
			onSteer={vi.fn(async () => ({ success: true }))}
			onAbort={vi.fn()} onSelectModel={vi.fn()} onSelectLevel={vi.fn()}
		/>,
	);
}

describe("引用 chip 的显示", () => {
	it("目录带尾斜杠，其余保留尾部两段：目录和同名文件都分得清", () => {
		renderInput({ references: ["src/lib/", "src/lib/index.ts", "src/components/index.ts", "README.md"] });
		const chips = screen.getByTestId("composer-references");
		// 只取标签那一段（chip 里还有 ✕ 按钮，textContent 会把它也带上）
		const labels = [...chips.querySelectorAll("[title] span.truncate")].map((node) => node.textContent);
		expect(labels).toEqual(["src/lib/", "…/lib/index.ts", "…/components/index.ts", "README.md"]);
		// 完整路径仍在 title 里（hover 能看到）
		expect(chips.querySelector('[title="src/lib/index.ts"]')).toBeTruthy();
	});

	it("超过 4 个先折叠：前 4 个 + 「展开 N」，点开显示全部并能收起", () => {
		const many = Array.from({ length: 7 }, (_, i) => `src/lib/file-${i}.ts`);
		renderInput({ references: many });
		const chips = screen.getByTestId("composer-references");
		expect(chips.querySelectorAll("[title] span.truncate")).toHaveLength(4);
		expect(screen.getByTestId("references-toggle").textContent).toBe("展开 3");

		fireEvent.click(screen.getByTestId("references-toggle"));
		expect(screen.getByTestId("composer-references").querySelectorAll("[title] span.truncate")).toHaveLength(7);
		fireEvent.click(screen.getByTestId("references-toggle"));
		expect(screen.getByTestId("composer-references").querySelectorAll("[title] span.truncate")).toHaveLength(4);
	});

	it("不超过 4 个不出现折叠开关", () => {
		renderInput({ references: ["a.ts", "b.ts", "c.ts", "d.ts"] });
		expect(screen.queryByTestId("references-toggle")).toBeNull();
	});
});

describe("图片 chip", () => {
	const png = { type: "image" as const, data: "AAAA", mimeType: "image/png" };
	const jpeg = { type: "image" as const, data: "BBBB", mimeType: "image/jpeg" };

	it("缩略图不裁切，点开可放大，Esc 关闭", () => {
		renderInput({ images: [png, jpeg] });
		const thumbs = screen.getAllByLabelText("点击放大预览");
		expect(thumbs).toHaveLength(2);
		expect(thumbs[0].querySelector("img")?.className).toContain("object-contain");
		expect(thumbs[0].querySelector("img")?.className).not.toContain("object-cover");
		fireEvent.click(thumbs[0]);
		const dialog = screen.getByRole("dialog");
		expect(dialog.querySelector("img")?.getAttribute("src")).toContain("AAAA");
		fireEvent.keyDown(document, { key: "Escape" });
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("超过 4 张折叠成牌堆：只显示正面那张 + 「展开 N」，展开后逐张可点开", () => {
		const many = Array.from({ length: 6 }, (_, i) => ({ type: "image" as const, data: `IMG${i}`, mimeType: "image/png" }));
		renderInput({ images: many });
		// 牌堆：只有正面那张是可点的缩略图（后面几张只是露出的边缘）
		expect(screen.getAllByLabelText("点击放大预览")).toHaveLength(1);
		expect(screen.getByTestId("images-toggle").textContent).toBe("展开 5");
		// 露出的边缘是后面几张的图，不是装饰
		expect(document.querySelectorAll('img[src*="IMG1"]').length).toBeGreaterThan(0);

		fireEvent.click(screen.getByTestId("images-toggle"));
		expect(screen.getAllByLabelText("点击放大预览")).toHaveLength(6);
		fireEvent.click(screen.getAllByLabelText("点击放大预览")[2]);
		expect(screen.getByRole("dialog").querySelector("img")?.getAttribute("src")).toContain("IMG2");
		fireEvent.keyDown(document, { key: "Escape" });
		fireEvent.click(screen.getByTestId("images-toggle"));
		expect(screen.getAllByLabelText("点击放大预览")).toHaveLength(1);
	});

	it("不超过 4 张不折叠", () => {
		renderInput({ images: [png, jpeg, { ...png, data: "CCCC" }, { ...png, data: "DDDD" }] });
		expect(screen.getAllByLabelText("点击放大预览")).toHaveLength(4);
		expect(screen.queryByTestId("images-toggle")).toBeNull();
	});

	it("删除按钮按序号标识，删掉的是对应那张", () => {
		renderInput({ images: [png, jpeg] });
		fireEvent.click(screen.getByLabelText("删除 1"));
		const left = screen.getAllByLabelText("点击放大预览");
		expect(left).toHaveLength(1);
		expect(left[0].querySelector("img")?.getAttribute("src")).toContain("BBBB");
	});
});
