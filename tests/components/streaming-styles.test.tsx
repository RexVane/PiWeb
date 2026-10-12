// @vitest-environment jsdom
/**
 * 流式显示样式（设置里可选的四种）+ 打字光标。
 * 组件只做「按偏好把显示进度往前推」这一件事，所以这里盯三样：显示出来的文字、推进的节拍、DOM 结构。
 * 偏好是模块级单例（lib/chat/stream-settings），每个用例前后都归位，避免相互串味。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { StreamingMarkdownBlock } from "@/components/MarkdownBlock";
import { DEFAULT_STREAM_SETTINGS, setStreamSettings } from "@/lib/chat/stream-settings";

beforeEach(() => setStreamSettings(DEFAULT_STREAM_SETTINGS));

afterEach(() => {
	cleanup();
	setStreamSettings(DEFAULT_STREAM_SETTINGS);
	vi.useRealTimers();
});

describe("StreamingMarkdownBlock 显示样式", () => {
	it("即时：不做平滑，整段立即可见", () => {
		setStreamSettings({ style: "instant" });
		const { container, rerender } = render(<StreamingMarkdownBlock text="第一段" />);
		rerender(<StreamingMarkdownBlock text={"第一段\n\n第二段"} />);
		expect(container.textContent).toBe("第一段第二段");
		expect(container.querySelector(".pw-stream")?.getAttribute("data-stream-style")).toBe("instant");
	});

	it("打字机：每帧固定几个字，匀速推进", () => {
		setStreamSettings({ style: "typewriter", speed: 3 });
		vi.useFakeTimers();
		const { container, rerender } = render(<StreamingMarkdownBlock text="" />);
		rerender(<StreamingMarkdownBlock text="abcdefghij" />);
		act(() => { vi.advanceTimersByTime(16); });
		expect(container.textContent).toBe("abc");
		act(() => { vi.advanceTimersByTime(16); });
		expect(container.textContent).toBe("abcdef");
	});

	it("渐显：段落边界照常切块，淡入交给 data-stream-style 上的 CSS", () => {
		setStreamSettings({ style: "fade", speed: 5 });
		vi.useFakeTimers();
		const { container, rerender } = render(<StreamingMarkdownBlock text="" />);
		rerender(<StreamingMarkdownBlock text={"甲段\n\n乙段\n\n丙"} />);
		for (let i = 0; i < 40; i += 1) act(() => { vi.advanceTimersByTime(16); });
		const stream = container.querySelector(".pw-stream");
		expect(stream?.getAttribute("data-stream-style")).toBe("fade");
		// 块不能各自包一层：包了 .pw-narr 的 p + p 段间距就不生效了（这里盯住 DOM 结构）
		expect(container.querySelector(".pw-stream > p + p")).not.toBeNull();
		expect(container.textContent).toBe("甲段乙段丙");
	});

	it("打字光标：开着时尾巴包一层（光标由 CSS 挂上去）", () => {
		setStreamSettings({ style: "smooth", caret: true });
		const { container } = render(<StreamingMarkdownBlock text="甲段" />);
		expect(container.querySelector(".pw-stream-caret .pw-stream-tail")).not.toBeNull();
	});

	it("光标关着时容器上没有光标类（尾巴包装层常驻：稳定 tail 身份、防止块升级时重挂闪动）", () => {
		setStreamSettings({ style: "smooth", caret: false });
		const { container } = render(<StreamingMarkdownBlock text="甲段" />);
		expect(container.querySelector(".pw-stream-tail")).not.toBeNull();
		expect(container.querySelector(".pw-stream-caret")).toBeNull();
	});

	it("流式期间改样式：下一帧就换，不用重开会话", () => {
		setStreamSettings({ style: "typewriter", speed: 1 });
		vi.useFakeTimers();
		const { container, rerender } = render(<StreamingMarkdownBlock text="" />);
		rerender(<StreamingMarkdownBlock text={"a".repeat(60)} />);
		act(() => { vi.advanceTimersByTime(24); });
		expect(container.textContent).toBe("a"); // 打字机 speed1：一帧一个字
		act(() => { setStreamSettings({ style: "instant" }); });
		expect(container.textContent).toBe("a".repeat(60)); // 切即时：停表追平
	});
});
