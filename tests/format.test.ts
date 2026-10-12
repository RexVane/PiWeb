/**
 * 数字显示格式与上下文分段归一。
 *
 * 背景（2026-10-12）：
 * - 用户要求「缓存 / tokens / 输出速度 / 上下文这些显示的数字精确到小数点后两位」；
 * - 上下文弹窗的 12 个分项是「字符数 ÷ 4」估算，与头部的 SDK 真实用量不同源，
 *   实测分段之和比头部高 9.2%，且 Free Space 用分段之和算，导致「头部 + Free ≠ 窗口」。
 */
import { describe, expect, it } from "vitest";
import { fmtBytes, fmtCount, fmtDuration, fmtPercent, fmtThroughput, fmtTokens } from "../src/lib/format";
import { scaleSegmentsToTotal } from "../src/lib/process-format";

describe("数字显示格式", () => {
	it("token 量用 K / M 两位小数，1000 以下保持整数", () => {
		expect(fmtTokens(786)).toBe("786");
		expect(fmtTokens(999)).toBe("999");
		expect(fmtTokens(1000)).toBe("1.00K");
		expect(fmtTokens(42_730)).toBe("42.73K");
		expect(fmtTokens(273_150)).toBe("273.15K");
		expect(fmtTokens(1_000_000)).toBe("1.00M");
		expect(fmtTokens(42_730_000)).toBe("42.73M");
	});

	it("K 缩放到两位小数后满 1000 会升级成 M，不出现 1000.00K", () => {
		expect(fmtTokens(999_999)).toBe("1.00M");
	});

	it("百分比两位小数", () => {
		expect(fmtPercent(98)).toBe("98.00%");
		expect(fmtPercent(19.6487)).toBe("19.65%");
		expect(fmtPercent(0)).toBe("0.00%");
	});

	it("速率两位小数", () => {
		expect(fmtThroughput(107)).toBe("107.00");
		expect(fmtThroughput(7.456)).toBe("7.46");
	});

	it("时长：秒级两位小数，分钟级用 19m30s", () => {
		expect(fmtDuration(5320)).toBe("5.32s");
		expect(fmtDuration(999)).toBe("1.00s");
		expect(fmtDuration(60_000)).toBe("1m0s");
		expect(fmtDuration(1_170_000)).toBe("19m30s");
	});

	it("计数保持整数", () => {
		expect(fmtCount(493)).toBe("493");
	});

	it("文件大小：B 整数，KB / MB 两位小数", () => {
		expect(fmtBytes(0)).toBe("0 B");
		expect(fmtBytes(512)).toBe("512 B");
		expect(fmtBytes(5_529)).toBe("5.40 KB");
		expect(fmtBytes(1_258_291)).toBe("1.20 MB");
	});
});

describe("上下文分段归一", () => {
	it("按比例缩放到真实用量，求和精确等于总量（最大余数法）", () => {
		const segs = [
			{ key: "a", tokens: 100 },
			{ key: "b", tokens: 100 },
			{ key: "c", tokens: 100 },
		];
		const out = scaleSegmentsToTotal(segs, 10);
		expect(out.reduce((s, x) => s + x.tokens, 0)).toBe(10);
		// 比例不变
		expect(out.map((x) => x.tokens)).toEqual([4, 3, 3]);
	});

	it("余数按小数部分从大到小分配，合计不因取整漂移", () => {
		const segs = [{ key: "a", tokens: 1 }, { key: "b", tokens: 1 }, { key: "c", tokens: 1 }];
		const total = 100;
		const out = scaleSegmentsToTotal(segs, total);
		expect(out.reduce((s, x) => s + x.tokens, 0)).toBe(total);
	});

	it("真实用量未知时保持原样（冷会话退回估算口径）", () => {
		const segs = [{ key: "a", tokens: 7 }, { key: "b", tokens: 3 }];
		expect(scaleSegmentsToTotal(segs, null).map((s) => s.tokens)).toEqual([7, 3]);
		expect(scaleSegmentsToTotal(segs, 0).map((s) => s.tokens)).toEqual([7, 3]);
	});

	it("分项全为 0 时不产生 NaN", () => {
		const segs = [{ key: "a", tokens: 0 }, { key: "b", tokens: 0 }];
		expect(scaleSegmentsToTotal(segs, 1000).map((s) => s.tokens)).toEqual([0, 0]);
	});

	it("保留未在分项里的原始字段（label / color）", () => {
		const segs = [{ key: "a", label: "A", color: "red", tokens: 50 }];
		const out = scaleSegmentsToTotal(segs, 100);
		expect(out[0]).toMatchObject({ key: "a", label: "A", color: "red", tokens: 100 });
	});
});
