// @vitest-environment jsdom
/**
 * 对话区贴底：往上翻就松开，不等离底 96px。
 * 流式正文每帧都会贴一次底（见 chat/chat-scroll），旧判定下往上翻 40px 还算「贴底」，
 * 下一帧就被拽回去，大纲 / 搜索的平滑跳转刚起步也会被打断。
 * jsdom 不排版，这里给滚动容器装上假的尺寸和 scrollTop。
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { ChatWindow } from "@/components/ChatWindow";
import type { WebMessage } from "@/lib/types";

afterEach(cleanup);

const question = { role: "user", id: "u1", content: [{ type: "text", text: "问" }], timestamp: 1 } as unknown as WebMessage;
const reply = (text: string) => ({ role: "assistant", id: "a1", content: [{ type: "text", text }], stopReason: "pending", timestamp: 2 }) as unknown as WebMessage;

/** 内容 2000、视口 500：最底下 scrollTop = 1500 */
function fakeScroller(node: HTMLElement) {
	let top = 0;
	Object.defineProperty(node, "scrollHeight", { configurable: true, get: () => 2000 });
	Object.defineProperty(node, "clientHeight", { configurable: true, get: () => 500 });
	Object.defineProperty(node, "scrollTop", { configurable: true, get: () => top, set: (value: number) => { top = Math.max(0, Math.min(value, 1500)); } });
	return {
		/** 用户滚到这里（会触发滚动事件） */
		scrollTo(value: number) {
			top = value;
			fireEvent.scroll(node);
		},
		get top() {
			return top;
		},
	};
}

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

describe("ChatWindow 贴底", () => {
	it("往上翻 40px 就不再跟着新内容贴底；滚回底部附近又跟上", async () => {
		const { rerender } = render(<ChatWindow messages={[question, reply("第一句")]} tools={{}} isStreaming />);
		const scroller = fakeScroller(document.querySelector<HTMLElement>('[role="log"]')!);
		scroller.scrollTo(1500);
		scroller.scrollTo(1460);
		rerender(<ChatWindow messages={[question, reply("第一句，第二句")]} tools={{}} isStreaming />);
		await nextFrame();
		expect(scroller.top).toBe(1460);

		// 往下回到 96px 以内：重新贴底，新内容来了跟着走
		scroller.scrollTo(1480);
		rerender(<ChatWindow messages={[question, reply("第一句，第二句，第三句")]} tools={{}} isStreaming />);
		await nextFrame();
		expect(scroller.top).toBe(1500);
	});
});
