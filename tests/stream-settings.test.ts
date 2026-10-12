/**
 * 流式推进数学（lib/chat/stream-settings）：
 * - 不变量：显示内容始终是目标前缀、单调增长、最终追平；
 * - 各样式的手感差异：即时一帧追平、打字机固定节奏、平滑积压越多推得越快、渐显停在整词处；
 * - 代理对安全：不在 emoji 中间切出半个字符。
 */
import { describe, expect, it } from "vitest";
import {
	DEFAULT_STREAM_SETTINGS,
	getStreamSettings,
	nextRevealEnd,
	safeSliceEnd,
	setStreamSettings,
	streamStepMs,
	type StreamSettings,
	type StreamStyle,
} from "@/lib/chat/stream-settings";

const make = (style: StreamStyle, speed = 3): StreamSettings => ({ style, speed, caret: false });

const styles: StreamStyle[] = ["smooth", "typewriter", "fade", "instant"];

const samples = [
	"短句",
	"第一段。\n\n第二段在写",
	"```ts\nconst a = 1;\n\nconst b = 2;\n",
	"混排 😀🙂 emoji 与 English words here",
	"1. 甲\n\n2. 乙\n\n3. 丙",
	"a".repeat(500),
];

describe("nextRevealEnd", () => {
	for (const style of styles) {
		it(`${style}：每帧都在前进，最后一定追平`, () => {
			for (const target of samples) {
				const settings = make(style);
				let shown = 0;
				for (let frame = 0; frame < 5000 && shown < target.length; frame += 1) {
					const end = nextRevealEnd(target, shown, settings);
					expect(end).toBeGreaterThan(shown);
					expect(end).toBeLessThanOrEqual(target.length);
					shown = end;
				}
				expect(shown).toBe(target.length);
			}
		});
	}

	it("即时：不做平滑，一帧就追平", () => {
		const target = "a".repeat(500);
		expect(nextRevealEnd(target, 0, make("instant"))).toBe(500);
	});

	it("打字机：每帧就是固定那几个字（速度档位越大越多）", () => {
		const target = "abcdefghijklmnopqrstuvwxyz";
		expect(nextRevealEnd(target, 0, make("typewriter", 3))).toBe(3);
		expect(nextRevealEnd(target, 3, make("typewriter", 3))).toBe(6);
		expect(nextRevealEnd(target, 0, make("typewriter", 5))).toBe(8);
	});

	it("打字机：积压太多时跟着加速，不出现「回答完了字还在爬」", () => {
		const target = "a".repeat(900);
		expect(nextRevealEnd(target, 0, make("typewriter", 1))).toBe(10);
	});

	it("平滑：积压越多每帧推得越远", () => {
		const target = "a".repeat(100);
		const far = nextRevealEnd(target, 0, make("smooth"));
		const near = nextRevealEnd(target, 96, make("smooth")) - 96;
		expect(far).toBeGreaterThan(near);
		expect(near).toBeGreaterThanOrEqual(1);
	});

	it("平滑：单帧推进有上限，大块突发被摊到多帧而不是一口吞掉", () => {
		const target = "a".repeat(5000);
		expect(nextRevealEnd(target, 0, make("smooth", 3))).toBe(90);
		expect(nextRevealEnd(target, 0, make("smooth", 1))).toBe(140);
		expect(nextRevealEnd(target, 0, make("smooth", 5))).toBe(50);
	});

	it("渐显：停在整词之后（不会露出半个词）", () => {
		const target = "alpha beta gamma";
		expect(nextRevealEnd(target, 0, make("fade", 5))).toBe("alpha ".length);
		// 速度 5 一帧最多推进 10 个字符：停在完整词 "beta" 之后（后半句还没揭示，越过空格不算半个词）
		expect(nextRevealEnd(target, "alpha ".length, make("fade", 5))).toBe("alpha beta".length);
	});

	it("渐显：末尾正在敲的那个词也会长出来（不会停在原地）", () => {
		const target = "alpha beta gamma";
		const settings = make("fade", 1);
		let shown = 0;
		for (let frame = 0; frame < 500 && shown < target.length; frame += 1) {
			const end = nextRevealEnd(target, shown, settings);
			expect(end).toBeGreaterThan(shown);
			shown = end;
		}
		expect(shown).toBe(target.length);
	});
});

describe("streamStepMs", () => {
	it("档位越高间隔越短，越界档位夹到两端", () => {
		expect(streamStepMs(5)).toBeLessThan(streamStepMs(1));
		expect(streamStepMs(3)).toBe(16);
		expect(streamStepMs(99)).toBe(streamStepMs(5));
		expect(streamStepMs(0)).toBe(streamStepMs(1));
	});
});

describe("safeSliceEnd", () => {
	it("不在代理对中间切开（半个 emoji 会渲染成替换字符）", () => {
		const text = "a😀b"; // 😀 = 两个 UTF-16 码元
		expect(safeSliceEnd(text, 1)).toBe(1);
		expect(safeSliceEnd(text, 2)).toBe(3);
		expect(safeSliceEnd(text, 4)).toBe(4);
	});

	it("越界时收口到文本两端", () => {
		expect(safeSliceEnd("abc", 99)).toBe(3);
		expect(safeSliceEnd("abc", -1)).toBe(0);
	});
});

describe("setStreamSettings", () => {
	it("速度夹到 1..5，非法样式保留原值", () => {
		setStreamSettings({ style: "typewriter", speed: 99, caret: true });
		expect(getStreamSettings()).toEqual({ style: "typewriter", speed: 5, caret: true });
		setStreamSettings({ speed: -3 });
		expect(getStreamSettings().speed).toBe(1);
		setStreamSettings({ style: "nope" as StreamStyle });
		expect(getStreamSettings().style).toBe("typewriter");
		setStreamSettings(DEFAULT_STREAM_SETTINGS);
		expect(getStreamSettings()).toEqual(DEFAULT_STREAM_SETTINGS);
	});
});
