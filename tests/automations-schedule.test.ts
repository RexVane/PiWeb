import { describe, expect, it, vi } from "vitest";
import { computeNextRunAt, describeSchedule, parseCronExpression, validateSchedule } from "@/lib/automations/schedule";

describe("automations schedule", () => {
	it("anchors a single-value cron step at its stated start and rolls over the hour", () => {
		const schedule = { kind: "cron" as const, expr: "5/20 * * * *" };
		expect(computeNextRunAt(schedule, new Date(2026, 0, 2, 9, 5).getTime())).toBe(new Date(2026, 0, 2, 9, 25).getTime());
		expect(computeNextRunAt(schedule, new Date(2026, 0, 2, 9, 45).getTime())).toBe(new Date(2026, 0, 2, 10, 5).getTime());
	});
	it("returns no occurrence for an impossible date instead of looping without a bound", () => {
		expect(computeNextRunAt({ kind: "cron", expr: "0 9 31 feb *" }, new Date(2026, 0, 1).getTime())).toBeNull();
	});
	it("uses OR for restricted month-day and weekday fields, including named months and weekdays", () => {
		const from = new Date(2026, 0, 2, 12).getTime();
		expect(computeNextRunAt({ kind: "cron", expr: "0 9 1 jan mon" }, from)).toBe(new Date(2026, 0, 5, 9).getTime());
		const afterMonday = new Date(2026, 0, 26, 12).getTime();
		expect(computeNextRunAt({ kind: "cron", expr: "0 9 31 jan mon" }, afterMonday)).toBe(new Date(2026, 0, 31, 9).getTime());
	});
	it("orders repeated DST hours by timestamp and skips nonexistent cron times", () => {
		vi.stubEnv("TZ", "America/New_York");
		try {
			expect(computeNextRunAt({ kind: "cron", expr: "10 1 * * *" }, Date.parse("2026-11-01T05:50:00Z"))).toBe(Date.parse("2026-11-01T06:10:00Z"));
			expect(computeNextRunAt({ kind: "cron", expr: "*/10 1 * * *" }, Date.parse("2026-11-01T05:05:00Z"))).toBe(Date.parse("2026-11-01T05:10:00Z"));
			expect(computeNextRunAt({ kind: "cron", expr: "30 2 * * *" }, Date.parse("2026-03-08T06:00:00Z"))).toBe(Date.parse("2026-03-09T06:30:00Z"));
		} finally { vi.unstubAllEnvs(); }
	});
	it("supports Sunday=7 at range endpoints and keeps starred day fields conjunctive", () => {
		expect(parseCronExpression("0 9 * * 0-7").dow.sorted).toEqual([0, 1, 2, 3, 4, 5, 6]);
		expect(parseCronExpression("0 9 * * 1-7").dow.sorted).toEqual([0, 1, 2, 3, 4, 5, 6]);
		expect(parseCronExpression("0 9 * * 5-7").dow.sorted).toEqual([0, 5, 6]);
		const tuesday = new Date(2026, 4, 12, 10, 0).getTime();
		expect(computeNextRunAt({ kind: "cron", expr: "0 9 */1 * 1" }, tuesday)).toBe(new Date(2026, 4, 18, 9, 0).getTime());
	});
	it("skips nonexistent daily and weekly wall times during the spring clock change", () => {
		vi.stubEnv("TZ", "America/New_York");
		try {
			const from = Date.parse("2026-03-08T05:00:00Z");
			expect(computeNextRunAt({ kind: "daily", time: "02:30" }, from)).toBe(Date.parse("2026-03-09T06:30:00Z"));
			expect(computeNextRunAt({ kind: "weekly", time: "02:30", days: [0] }, from)).toBe(Date.parse("2026-03-15T06:30:00Z"));
		} finally { vi.unstubAllEnvs(); }
	});
	it("validates and computes interval schedules", () => {
		const s = validateSchedule({ kind: "interval", every: 15, unit: "minutes" });
		const from = new Date(2026, 4, 10, 8, 10, 0, 0).getTime();
		expect(computeNextRunAt(s, from)).toBe(from + 15 * 60_000);

		const h = validateSchedule({ kind: "interval", every: 2, unit: "hours" });
		expect(computeNextRunAt(h, from)).toBe(from + 2 * 3_600_000);
		expect(() => validateSchedule({ kind: "interval", every: 0, unit: "minutes" })).toThrow();
	});

	it("computes daily schedule same-day or next-day strictly in future", () => {
		const s = validateSchedule({ kind: "daily", time: "9:05" });
		expect(s).toEqual({ kind: "daily", time: "09:05" });

		const before = new Date(2026, 4, 10, 8, 59, 0, 0).getTime();
		expect(computeNextRunAt(s, before)).toBe(new Date(2026, 4, 10, 9, 5, 0, 0).getTime());

		const exact = new Date(2026, 4, 10, 9, 5, 0, 0).getTime();
		expect(computeNextRunAt(s, exact)).toBe(new Date(2026, 4, 11, 9, 5, 0, 0).getTime());
	});

	it("computes weekly schedules across week wraparound", () => {
		// 2026-05-10 is Sunday (0). Schedule Monday (1) & Friday (5) at 18:30.
		const s = validateSchedule({ kind: "weekly", days: [5, 1, 1], time: "18:30" });
		expect(s).toEqual({ kind: "weekly", days: [1, 5], time: "18:30" });

		const sunday = new Date(2026, 4, 10, 12, 0, 0, 0).getTime();
		expect(computeNextRunAt(s, sunday)).toBe(new Date(2026, 4, 11, 18, 30, 0, 0).getTime());

		const fridayLate = new Date(2026, 4, 15, 19, 0, 0, 0).getTime();
		expect(computeNextRunAt(s, fridayLate)).toBe(new Date(2026, 4, 18, 18, 30, 0, 0).getTime());
	});

	it("parses and evaluates 5-field cron expressions and aliases", () => {
		const parsed = parseCronExpression("*/15 9-17 * * 1-5");
		expect(parsed.minute.sorted).toEqual([0, 15, 30, 45]);
		expect(parsed.hour.sorted).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
		expect(parsed.dow.sorted).toEqual([1, 2, 3, 4, 5]);

		// Saturday 2026-05-09 10:00 -> jumps to Monday 2026-05-11 09:00
		const saturday = new Date(2026, 4, 9, 10, 0, 0, 0).getTime();
		const s = validateSchedule({ kind: "cron", expr: "*/15 9-17 * * 1-5" });
		expect(computeNextRunAt(s, saturday)).toBe(new Date(2026, 4, 11, 9, 0, 0, 0).getTime());

		const dailyAlias = validateSchedule({ kind: "cron", expr: "@daily" });
		expect(dailyAlias).toEqual({ kind: "cron", expr: "0 0 * * *" });
		expect(() => validateSchedule({ kind: "cron", expr: "* * *" })).toThrow();
	});

	it("formats human-readable labels in zh and en", () => {
		expect(describeSchedule({ kind: "interval", every: 30, unit: "minutes" }, "zh")).toBe("每 30 分钟");
		expect(describeSchedule({ kind: "interval", every: 1, unit: "hours" }, "en")).toBe("Every 1 hour");
		expect(describeSchedule({ kind: "daily", time: "09:00" }, "zh")).toBe("每天 09:00");
		expect(describeSchedule({ kind: "weekly", days: [1, 3], time: "10:15" }, "zh")).toBe("每周一、周三 10:15");
	});
});
