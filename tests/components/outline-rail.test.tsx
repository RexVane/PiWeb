// @vitest-environment jsdom
/**
 * 大纲导航（按回合分组）：
 * - 正文是按需加载的 Markdown：刷新后直接恢复会话时，快照到了正文还没出来，用户行里只有
 *   「10月7日 16:49」这类时间戳。收集时只取气泡正文，正文晚到再由 MutationObserver 补收，
 *   所以绝不会把裸时间戳当成一项列出来。
 * - 展开态一行一个回合：左侧是浅灰的时间与轮数（比右侧矮一档），右侧是用户提示词；
 *   鼠标悬停某一行时在其下方展开该回合回答的小标题（回复 title），且同一时刻只展开一个。
 */
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { OutlineRail } from "@/components/OutlineRail";

afterEach(cleanup);

function Harness() {
	const ref = useRef<HTMLDivElement>(null);
	return (
		<div>
			<div ref={ref} data-testid="log">
				{[1, 2, 3].map((i) => (
					<div key={i}>
						<div data-role="user">
							{/* Markdown 分块还没加载：气泡是空的，只有动作行里的时间 */}
							<div className="msg-user-bubble" data-testid={`bubble-${i}`} />
							<div className="msg-actions">
								<span className="msg-clock msg-clock-start">10月{i}日 16:49</span>
							</div>
						</div>
						<div data-role="assistant" data-testid={`answer-${i}`} />
					</div>
				))}
			</div>
			<OutlineRail scrollRef={ref} revision="3:0" />
		</div>
	);
}

/** 模拟 Markdown 分块加载完成：气泡和回答里的正文、标题这时才出现 */
function loadMarkdown() {
	for (const i of [1, 2, 3]) {
		screen.getByTestId(`bubble-${i}`).innerHTML = `<div class="md"><p>问题 ${i}</p></div>`;
		screen.getByTestId(`answer-${i}`).innerHTML = `<div class="md"><h2>标题 ${i}</h2><p>正文</p></div>`;
	}
}

describe("outline rail", () => {
	it("never lists bare timestamps and picks up content that loads later", async () => {
		const { container } = render(<Harness />);
		// 正文没出来之前：一项都不该收（改前这里是 3 条「10月N日 16:49」）
		await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
		expect(container.querySelector(".outline-rail")).toBeNull();

		act(() => loadMarkdown());
		await waitFor(() => expect(container.querySelector(".outline-rail")).not.toBeNull());
		fireEvent.mouseEnter(container.querySelector(".outline-rail")!);
		const prompts = [...container.querySelectorAll(".outline-turn-prompt")].map((el) => el.textContent);
		expect(prompts).toEqual(["问题 1", "问题 2", "问题 3"]);
	});

	it("groups by turn and shows time + round on the left, prompt on the right", async () => {
		const { container } = render(<Harness />);
		act(() => loadMarkdown());
		await waitFor(() => expect(container.querySelector(".outline-rail")).not.toBeNull());
		fireEvent.mouseEnter(container.querySelector(".outline-rail")!);

		const turns = container.querySelectorAll(".outline-turn");
		expect(turns.length).toBe(3);
		expect(turns[0].querySelector(".outline-turn-prompt")?.textContent).toBe("问题 1");
		const meta = turns[0].querySelector(".outline-turn-meta")?.textContent ?? "";
		expect(meta).toContain("16:49");
		expect(meta).toContain("第 1 轮");
		// 未悬停任何一行时，不展开回复标题
		expect(container.querySelector(".outline-turn-replies")).toBeNull();
	});

	it("expands the reply title on hover, one at a time (accordion)", async () => {
		const { container } = render(<Harness />);
		act(() => loadMarkdown());
		await waitFor(() => expect(container.querySelector(".outline-rail")).not.toBeNull());
		fireEvent.mouseEnter(container.querySelector(".outline-rail")!);

		const turns = container.querySelectorAll(".outline-turn");
		// 悬停第 2 行 → 展开它的回复标题
		fireEvent.mouseEnter(turns[1]);
		await waitFor(() => expect(turns[1].querySelector(".outline-turn-replies")?.textContent).toContain("标题 2"));
		expect(container.querySelectorAll(".outline-turn-replies").length).toBe(1);

		// 悬停第 3 行 → 第 2 行收起，仍只有一个展开
		fireEvent.mouseEnter(turns[2]);
		await waitFor(() => expect(turns[2].querySelector(".outline-turn-replies")?.textContent).toContain("标题 3"));
		expect(turns[1].querySelector(".outline-turn-replies")).toBeNull();
		expect(container.querySelectorAll(".outline-turn-replies").length).toBe(1);
	});
});
