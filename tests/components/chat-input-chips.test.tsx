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
import { deckLayout, fanLayout } from "@/components/composer/ComposerImages";

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

	it("缩略图不裁切，点开可放大，Esc 关闭且不外溢，焦点还给缩略图", () => {
		renderInput({ images: [png, jpeg] });
		const thumbs = screen.getAllByLabelText("点击放大预览");
		expect(thumbs).toHaveLength(2);
		expect(thumbs[0].querySelector("img")?.className).toContain("object-contain");
		expect(thumbs[0].querySelector("img")?.className).not.toContain("object-cover");
		thumbs[0].focus();
		fireEvent.click(thumbs[0]);
		const dialog = screen.getByRole("dialog");
		// 挂在 body 上：输入卡祖先的 backdrop-filter 会让 fixed 只盖住输入卡
		expect(dialog.parentElement).toBe(document.body);
		expect(dialog.querySelector("img")?.getAttribute("src")).toContain("AAAA");
		expect(document.activeElement?.getAttribute("aria-label")).toBe("关闭");

		// 页面上其它监听 document 的面板（文件预览、设置等）不该跟着被 Esc 关掉
		const outer = vi.fn();
		document.addEventListener("keydown", outer);
		fireEvent.keyDown(document.activeElement!, { key: "Escape" });
		document.removeEventListener("keydown", outer);
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(outer).not.toHaveBeenCalled();
		expect(document.activeElement).toBe(thumbs[0]);
	});

	it("预览里 ← → 切换、显示第几张，点背景关闭、点图片不关", () => {
		renderInput({ images: [png, jpeg] });
		fireEvent.click(screen.getAllByLabelText("点击放大预览")[0]);
		const dialog = screen.getByRole("dialog");
		expect(dialog.textContent).toContain("1 / 2");
		fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
		expect(dialog.querySelector("img")?.getAttribute("src")).toContain("BBBB");
		expect(dialog.textContent).toContain("2 / 2");
		// 循环：最后一张再往右回到第一张
		fireEvent.click(within(dialog).getByLabelText("下一张"));
		expect(dialog.querySelector("img")?.getAttribute("src")).toContain("AAAA");
		fireEvent.click(dialog.querySelector("img")!);
		expect(screen.queryByRole("dialog")).toBeTruthy();
		fireEvent.click(dialog);
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	const many = (count: number) => Array.from({ length: count }, (_, i) => ({ type: "image" as const, data: `IMG${i}`, mimeType: "image/png" }));
	const poseOf = (card: HTMLElement) => {
		const match = /translate\(([-\d.]+)px, ([-\d.]+)px\) rotate\(([-\d.]+)deg\)/.exec(card.style.transform);
		return match ? { x: Number(match[1]), y: Number(match[2]), angle: Number(match[3]) } : null;
	};

	it("超过 4 张折叠成牌堆：正面在最上、后面最多露 4 层边、只有正面能点能删", () => {
		renderInput({ images: many(7) });
		const fan = screen.getByTestId("image-fan");
		const cards = [...fan.children] as HTMLElement[];
		expect(screen.getByTestId("images-toggle").textContent).toBe("展开 6");
		expect(screen.getByTestId("images-toggle").getAttribute("aria-expanded")).toBe("false");
		expect(fan.style.height).toBe("96px");
		expect(fan.style.width).toBe("112px"); // 96 + 4 层 × 4px
		// 只横向错位、不旋转；第 5 张起叠在第 4 层下面不显示
		expect(cards.map(poseOf)).toEqual([0, 4, 8, 12, 16, 16, 16].map((x) => ({ x, y: 0, angle: 0 })));
		expect(cards.map((card) => card.dataset.hidden ?? "")).toEqual(["", "", "", "", "", "true", "true"]);
		// 层级是正数、正面那张最高（负 z-index 会掉到输入卡背景后面）
		expect(cards.map((card) => Number(card.style.zIndex))).toEqual([7, 6, 5, 4, 3, 2, 1]);
		// 后面几张只露个边：不进 Tab 顺序，也没有删除按钮
		expect(screen.getByLabelText("删除 1")).toBeTruthy();
		expect(screen.queryByLabelText("删除 2")).toBeNull();
		expect(cards.map((card) => card.querySelector("button")!.tabIndex)).toEqual([0, -1, -1, -1, -1, -1, -1]);
	});

	it("展开沿向上拱的弧线扇开：同一批卡片换 transform、左右对称、中间最高，每张都能删", () => {
		renderInput({ images: many(7) });
		const fan = screen.getByTestId("image-fan");
		const before = [...fan.children];
		fireEvent.click(screen.getByTestId("images-toggle"));
		expect(screen.getByTestId("images-toggle").textContent).toBe("收起");
		expect(screen.getByTestId("images-toggle").getAttribute("aria-expanded")).toBe("true");
		const cards = [...fan.children] as HTMLElement[];
		// 同一批 DOM 节点：transform 才能过渡出扇开的动画
		expect(cards).toEqual(before);
		const poses = cards.map((card) => poseOf(card)!);
		expect(poses[3].angle).toBe(0);
		for (let i = 0; i < 3; i += 1) {
			expect(poses[i].angle).toBe(-poses[6 - i].angle);
			expect(poses[i].y).toBe(poses[6 - i].y);
			expect(poses[i].y).toBeGreaterThan(poses[i + 1].y);
		}
		expect(poses.every((pose, i) => i === 0 || pose.x > poses[i - 1].x)).toBe(true);
		expect(Number(fan.style.height.replace("px", ""))).toBeGreaterThan(96);
		expect(cards.every((card) => !card.dataset.hidden)).toBe(true);
		// 层级顺序不变（左压右），每张露出来的右侧条带里都有自己的删除按钮
		expect(cards.map((card) => Number(card.style.zIndex))).toEqual([7, 6, 5, 4, 3, 2, 1]);
		expect(Array.from({ length: 7 }, (_, i) => screen.queryByLabelText(`删除 ${i + 1}`))).not.toContain(null);

		// 悬停那张抬起来、放到最上层
		fireEvent.mouseEnter(cards[3]);
		expect(cards[3].style.zIndex).toBe("8");
		expect(poseOf(cards[3])!.y).toBeLessThan(poses[3].y);
		fireEvent.mouseLeave(cards[3]);
		expect(cards[3].style.zIndex).toBe("4");

		fireEvent.click(screen.getByTestId("images-toggle"));
		expect(fan.style.height).toBe("96px");
	});

	it("预览里删除后接着看下一张；删的是哪张，其余卡片的 DOM 原样保留", () => {
		renderInput({ images: many(6) });
		const fan = screen.getByTestId("image-fan");
		const second = fan.querySelector('img[src*="IMG1"]');
		fireEvent.click(screen.getByTestId("images-toggle"));
		fireEvent.click(screen.getAllByLabelText("点击放大预览")[2]);
		const dialog = screen.getByRole("dialog");
		expect(dialog.querySelector("img")?.getAttribute("src")).toContain("IMG2");
		fireEvent.click(within(dialog).getByText("删除"));
		expect(screen.getByRole("dialog").querySelector("img")?.getAttribute("src")).toContain("IMG3");
		expect(screen.getByRole("dialog").textContent).toContain("3 / 5");
		expect(fan.children).toHaveLength(5);
		// key 不再是「base64 前 12 位 + 下标」：删掉中间一张，后面的卡片不会被复用成别的图
		expect(fan.querySelector('img[src*="IMG1"]')).toBe(second);
	});

	it("扇形按容器宽度铺开：宽时间距有上限，窄时挤一挤但不出界", () => {
		const wide = fanLayout(5, 800);
		expect(wide.cards[1].x - wide.cards[0].x).toBeLessThanOrEqual(76);
		expect(wide.width).toBeLessThan(500);
		const narrow = fanLayout(16, 340);
		expect(narrow.width).toBeLessThanOrEqual(340);
		expect(narrow.cards[15].x).toBeGreaterThan(narrow.cards[0].x);
		expect(deckLayout(2)).toMatchObject({ width: 100, height: 96 });
	});

	it("张数多、条带太窄时标成拥挤：删除按钮只在悬停 / 聚焦那张上出现（不挤成一排）", () => {
		renderInput({ images: many(16) });
		const fan = screen.getByTestId("image-fan");
		fireEvent.click(screen.getByTestId("images-toggle"));
		expect(fan.dataset.crowded).toBe("true");
		cleanup();
		renderInput({ images: many(6) });
		fireEvent.click(screen.getByTestId("images-toggle"));
		expect(screen.getByTestId("image-fan").dataset.crowded).toBeUndefined();
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
/** 附件轨整体浮在输入卡上方：不占布局高度、不把输入框顶上去，多的直接盖住聊天记录 */
describe("附件轨的浮层与上传文件折叠", () => {
	it("上传文件超过 4 个先折叠，点「展开 N」全出，再点收回", () => {
		const uploads = [1, 2, 3, 4, 5, 6].map((i) => ({ name: `file-${i}.txt`, path: `/uploads/file-${i}.txt`, size: i * 1000 }));
		renderInput({ uploads });
		const rail = screen.getByTestId("composer-uploads");
		// title 就是文件路径：用它数当前显示了几张
		expect(rail.querySelectorAll("[title]")).toHaveLength(4);
		expect(screen.getByTestId("uploads-toggle").textContent).toBe("展开 2");
		fireEvent.click(screen.getByTestId("uploads-toggle"));
		expect(rail.querySelectorAll("[title]")).toHaveLength(6);
		expect(screen.getByTestId("uploads-toggle").textContent).toBe("收起");
		fireEvent.click(screen.getByTestId("uploads-toggle"));
		expect(rail.querySelectorAll("[title]")).toHaveLength(4);
	});

	it("三条轨道都在浮层里，浮层绝对定位于输入卡上方", () => {
		renderInput({ uploads: [{ name: "note.txt", path: "/uploads/note.txt", size: 4 }], references: ["src/lib/format.ts"] });
		const overlay = screen.getByTestId("composer-attachments");
		expect(overlay.className).toContain("absolute");
		expect(overlay.className).toContain("bottom-full");
		// 点击穿透要靠 pointer-events-none + 轨道自己 pointer-events-auto
		expect(overlay.className).toContain("pointer-events-none");
		expect(overlay.contains(screen.getByTestId("composer-uploads"))).toBe(true);
		expect(overlay.contains(screen.getByTestId("composer-references"))).toBe(true);
	});

	it("上传文件用与引用一致的降噪样式，删除按钮带文件名的无障碍标签", () => {
		renderInput({ uploads: [{ name: "note.txt", path: "/uploads/note.txt", size: 4 }] });
		const chip = screen.getByTestId("composer-uploads").querySelector(".pw-ref-chip") as HTMLElement;
		expect(chip).toBeTruthy();
		expect(screen.getByRole("button", { name: "删除 note.txt" })).toBeTruthy();
	});
});

