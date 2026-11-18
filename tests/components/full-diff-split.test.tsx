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
});
