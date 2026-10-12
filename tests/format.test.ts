/** 用户要求所有缩写 token、百分比与速率显示两位小数。 */
import { describe, expect, it } from "vitest";
import { fmtBytes, fmtCount, fmtDuration, fmtPercent, fmtThroughput, fmtTokens } from "../src/lib/format";

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
