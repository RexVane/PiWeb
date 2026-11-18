// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { FullDiff, type FullDiffHandle } from "@/components/FullDiff";
import type { DiffLine } from "@/components/DiffView";

afterEach(cleanup);

function makeSampleLines(): DiffLine[] {
	const out: DiffLine[] = [];
	out.push({ kind: "ctx", old: 1, new: 1, text: "# Title" });
	out.push({ kind: "del", old: 2, text: "old wording here" });
	out.push({ kind: "add", new: 2, text: "new wording here" });
	out.push({ kind: "add", new: 3, text: "extra line" });
	for (let k = 0; k < 12; k += 1) {
		out.push({ kind: "ctx", old: 3 + k, new: 4 + k, text: `unchanged_${k}` });
	}
	out.push({ kind: "add", new: 16, text: "tail addition" });
	return out;
}

describe("FullDiff split & inline modes", () => {
	it("renders continuous split panes, SVG curved ribbons, word highlights, and synchronized folding", () => {
		const lines = makeSampleLines();
		const view = render(<FullDiff lines={lines} language="markdown" folded layout="split" leftLabel="暂存区" rightLabel="工作区" />);
		expect(view.container.querySelector('[data-testid="split-diff"]')).toBeTruthy();
		expect(screen.getByText("暂存区")).toBeTruthy();
		expect(screen.getByText("工作区")).toBeTruthy();
		const ribbons = view.container.querySelectorAll("path.pw-sdiff-ribbon");
		expect(ribbons.length).toBe(2);
		expect(ribbons[0].getAttribute("data-kind")).toBe("mod");
		expect(ribbons[1].getAttribute("data-kind")).toBe("add");

		// 词级高亮
		const words = Array.from(view.container.querySelectorAll("mark.pw-diff-word")).map((m) => m.textContent);
		expect(words).toEqual(expect.arrayContaining(["old", "new"]));

		// 保留 +/- 标记以便可访问性与既有契约
		const signs = Array.from(view.container.querySelectorAll(".pw-fdiff-sign")).map((s) => s.textContent);
		expect(signs).toEqual(expect.arrayContaining(["-", "+"]));

		// 折叠条点击后两侧同步展开
		const folds = screen.getAllByRole("button", { name: /行未改动/ });
		expect(folds.length).toBe(2);
		fireEvent.click(folds[0]);
		expect(screen.queryAllByRole("button", { name: /行未改动/ })).toHaveLength(0);
	});

	it("renders hunk action checkboxes in split bridge and notifies with exact block index & anchor", () => {
		const onToggle = vi.fn();
		render(
			<FullDiff
				lines={makeSampleLines()}
				folded={false}
				layout="split"
				hunkAction={{ label: "暂存此块", checked: false, onToggle }}
			/>,
		);
		const firstBtn = screen.getByRole("button", { name: "暂存此块 #1" });
		const secondBtn = screen.getByRole("button", { name: "暂存此块 #2" });
		fireEvent.click(firstBtn);
		expect(onToggle).toHaveBeenCalledWith(0, { oldAnchor: 2, newAnchor: 2, delCount: 1, addCount: 2 });
		fireEvent.click(secondBtn);
		expect(onToggle).toHaveBeenCalledWith(1, { oldAnchor: 14, newAnchor: 16, delCount: 0, addCount: 1 });
	});

	it("supports inline layout with word highlights, exact hunk anchors, and imperative next/prev navigation", () => {
		const ref = createRef<FullDiffHandle>();
		const onToggle = vi.fn();
		const view = render(
			<FullDiff
				lines={makeSampleLines()}
				folded={false}
				layout="inline"
				handle={ref}
				initialChange
				hunkAction={{ label: "暂存此块", checked: false, onToggle }}
			/>,
		);
		expect(view.container.querySelector('[data-layout="inline"]')).toBeTruthy();
		expect(view.container.querySelectorAll("mark.pw-diff-word").length).toBeGreaterThanOrEqual(2);
		fireEvent.click(screen.getByRole("button", { name: "暂存此块 #1" }));
		expect(onToggle).toHaveBeenCalledWith(0, { oldAnchor: 2, newAnchor: 2, delCount: 1, addCount: 2 });
		fireEvent.click(screen.getByRole("button", { name: "暂存此块 #2" }));
		expect(onToggle).toHaveBeenCalledWith(1, { oldAnchor: 14, newAnchor: 16, delCount: 0, addCount: 1 });
		ref.current?.nextChange();
		ref.current?.prevChange();
	});

	it("absorbs async echo scrolls without fighting the active pane, ignores horizontal-only scroll, and reaches bottom on short overflow", () => {
		const lines: DiffLine[] = [];
		for (let i = 1; i <= 10; i += 1) lines.push({ kind: "ctx", old: i, new: i, text: `head_${i}` });
		for (let i = 11; i <= 42; i += 1) lines.push({ kind: "del", old: i, text: `deleted_${i}` });
		for (let i = 1; i <= 28; i += 1) lines.push({ kind: "ctx", old: 42 + i, new: 10 + i, text: `tail_${i}` });
		// 左 70 行 = 1400px，右 38 行 = 760px；视口 600px 时右最大仅 160px（小于 clientHeight/3）
		const view = render(<FullDiff lines={lines} folded={false} layout="split" />);
		const leftPane = view.container.querySelector(".pw-sdiff-left") as HTMLDivElement;
		const rightPane = view.container.querySelector(".pw-sdiff-right") as HTMLDivElement;

		Object.defineProperty(leftPane, "clientHeight", { configurable: true, value: 600 });
		Object.defineProperty(rightPane, "clientHeight", { configurable: true, value: 600 });
		Object.defineProperty(leftPane, "scrollHeight", { configurable: true, value: 1400 });
		Object.defineProperty(rightPane, "scrollHeight", { configurable: true, value: 760 });

		// 1) 拖拽/滚轮右侧（短溢出）滑到底部 160px，左侧也必须同步到真实底端 800px
		fireEvent.pointerDown(rightPane);
		rightPane.scrollTop = 160;
		fireEvent.scroll(rightPane);
		expect(leftPane.scrollTop).toBeCloseTo(800, 1);

		// 2) 模拟延迟到下一帧才触发的对侧回声 scroll（带 0.6px DPI 舍入误差），绝不能反向拖回源侧
		rightPane.scrollTop = 100;
		leftPane.scrollTop = 800 - 0.6;
		fireEvent.scroll(leftPane);
		expect(rightPane.scrollTop).toBe(100);

		// 3) 仅横向 scrollLeft 变化时，不得触发纵向同步覆盖另一侧位置
		leftPane.scrollLeft = 240;
		fireEvent.scroll(leftPane);
		expect(rightPane.scrollTop).toBe(100);

		// 4) 用户滚轮切回左侧主动滚动，立即接管并带动右侧同步
		fireEvent.wheel(leftPane);
		leftPane.scrollTop = 0;
		fireEvent.scroll(leftPane);
		expect(rightPane.scrollTop).toBe(0);
	});
});
