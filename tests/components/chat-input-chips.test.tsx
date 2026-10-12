// @vitest-environment jsdom
/**
 * 输入卡的 chip 显示：
 * - 引用：只取 basename 时目录和同名文件分不清（`src/lib` 与 `src/lib.ts`；`a/index.ts` 与 `b/index.ts`），
 *   所以目录带尾斜杠、其余保留尾部两段；
 * - 图片：以前是 56px 的 object-cover（裁成方形），贴了截图看不出是哪张，也点不开，
 *   现在不裁切、可点开放大、Esc 关闭。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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

	it("超过 4 张折叠成牌堆，点开后沿弧线扇开（同一批卡片做 transform，才有扇开动画）", () => {
		const many = Array.from({ length: 6 }, (_, i) => ({ type: "image" as const, data: `IMG${i}`, mimeType: "image/png" }));
		renderInput({ images: many });
		const fan = screen.getByTestId("image-fan");
		const cards = () => [...fan.children] as HTMLElement[];

		// 折叠：就是 96 高的一条，卡片不旋转、只用 4px 错位叠起来
		expect(screen.getByTestId("images-toggle").textContent).toBe("展开 5");
		expect(fan.style.height).toBe("96px");
		expect(cards().every((card) => !card.style.transform)).toBe(true);
		expect(cards()[1].style.marginLeft).toBe("-44px"); // -48 + 1*4：向右侧错开 4px
		expect(cards()[0].style.zIndex).toBe("0"); // 正面那张在最上（后面的是负 z）
		expect(cards()[1].style.zIndex).toBe("-1");

		// 展开：容器变高，卡片绕枢轴旋转成扇形（中心那张 0 度，两侧对称）
		fireEvent.click(screen.getByTestId("images-toggle"));
		expect(screen.getByTestId("images-toggle").textContent).toBe("收起");
		expect(fan.style.height).toBe("152px");
		const angles = cards().map((card) => /rotate\(([-\d.]+)deg\)/.exec(card.style.transform)?.[1]);
		expect(angles[0]).toBe(angles[5] === undefined ? undefined : `-${Number(angles[5])}`);
		// 6 张时步长 14 度：-35 -21 -7 +7 +21 +35，中心两张刚好在 0 两侧
		expect(angles).toEqual(["-35", "-21", "-7", "7", "21", "35"]);
		// 展开后每张都能点开预览（点第 3 张预览的就是第 3 张）
		fireEvent.click(screen.getAllByLabelText("点击放大预览")[2]);
		expect(screen.getByRole("dialog").querySelector("img")?.getAttribute("src")).toContain("IMG2");

		// 预览大图里也能删（扇形里卡片叠着，删除按钮靠悬停才露出来）
		fireEvent.click(within(screen.getByRole("dialog")).getByText("删除"));
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(cards()).toHaveLength(5);

		fireEvent.click(screen.getByTestId("images-toggle"));
		expect(fan.style.height).toBe("96px");
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
