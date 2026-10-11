// @vitest-environment jsdom
/**
 * 大纲导航：用户项要显示提问内容，不能只剩时间戳。
 *
 * 正文是按需加载的 Markdown：刷新后直接恢复会话时，快照到了正文还没出来，用户行里只有
 * 「10月7日 16:49」这类时间戳。改前大纲取整行 textContent、而且只在 revision 变化时收集，
 * 于是目录项全是时间、标题一个没有，正文加载出来也不再更新。
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
							<div className="msg-actions">10月{i}日 16:49</div>
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
		const labels = screen.getAllByRole("button").map((b) => b.textContent);
		expect(labels).toEqual(["问题 1", "标题 1", "问题 2", "标题 2", "问题 3", "标题 3"]);
		expect(labels.some((label) => label?.includes("16:49"))).toBe(false);
	});
});
