import type { AutomationSchedule } from "./types";
import type { Lang } from "@/lib/lang";

const CRON_ALIASES: Record<string, string> = {
	"@hourly": "0 * * * *",
	"@daily": "0 0 * * *",
	"@midnight": "0 0 * * *",
	"@weekly": "0 0 * * 0",
	"@monthly": "0 0 1 * *",
};

const MONTH_NAMES: Record<string, number> = {
	jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
	jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const DOW_NAMES: Record<string, number> = {
	sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

interface ParsedCronField {
	values: Set<number>;
	sorted: number[];
	isWildcard: boolean;
}

export interface ParsedCronExpression {
	normalized: string;
	minute: ParsedCronField;
	hour: ParsedCronField;
	dom: ParsedCronField;
	month: ParsedCronField;
	dow: ParsedCronField;
}

const MAX_LOOKAHEAD_DAYS = 1466; // > 4 years (covers leap day Feb 29)

/** Parse `HH:MM` (24-hour clock) or return null when invalid. */
export function parseTimeHHMM(raw: unknown): { hour: number; minute: number; normalized: string } | null {
	if (typeof raw !== "string") return null;
	const match = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(raw);
	if (!match) return null;
	const hour = Number(match[1]);
	const minute = Number(match[2]);
	if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
		return null;
	}
	return {
		hour,
		minute,
		normalized: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
	};
}

function parseCronToken(
	token: string,
	min: number,
	max: number,
	opts?: { names?: Record<string, number>; wrapSeven?: boolean },
): number {
	const lower = token.toLowerCase();
	if (opts?.names && Object.hasOwn(opts.names, lower)) return opts.names[lower];
	if (!/^\d+$/.test(token)) throw new Error(`Invalid cron token "${token}"`);
	const value = Number(token);
	if (value < min || value > max) throw new Error(`Cron value ${token} out of range [${min}, ${max}]`);
	return value;
}

function parseCronField(
	raw: string,
	min: number,
	max: number,
	opts?: { names?: Record<string, number>; wrapSeven?: boolean },
): ParsedCronField {
	const trimmed = raw.trim();
	if (!trimmed) throw new Error("Empty cron field");
	const isWildcard = trimmed.startsWith("*");
	const values = new Set<number>();

	for (const part of trimmed.split(",")) {
		if (!part) throw new Error(`Invalid cron segment in "${raw}"`);
		const slashIdx = part.indexOf("/");
		const rangePart = slashIdx >= 0 ? part.slice(0, slashIdx) : part;
		const stepPart = slashIdx >= 0 ? part.slice(slashIdx + 1) : undefined;
		if (slashIdx >= 0 && (!stepPart || !/^\d+$/.test(stepPart) || Number(stepPart) <= 0)) {
			throw new Error(`Invalid cron step "${part}"`);
		}
		const step = stepPart ? Number(stepPart) : 1;

		let start: number;
		let end: number;
		if (rangePart === "*") {
			start = min;
			end = max;
		} else if (rangePart.includes("-")) {
			const bounds = rangePart.split("-");
			if (bounds.length !== 2 || !bounds[0] || !bounds[1]) throw new Error(`Invalid cron range "${part}"`);
			start = parseCronToken(bounds[0], min, max, opts);
			end = parseCronToken(bounds[1], min, max, opts);
			if (start > end) throw new Error(`Invalid cron range "${part}"`);
		} else {
			const single = parseCronToken(rangePart, min, max, opts);
			start = single;
			end = stepPart ? max : single;
		}

		for (let v = start; v <= end; v += step) {
			values.add(opts?.wrapSeven && v === 7 ? 0 : v);
		}
	}

	if (values.size === 0) throw new Error(`Cron field "${raw}" matched no values`);
	return { values, sorted: Array.from(values).sort((a, b) => a - b), isWildcard };
}

/** Parse and validate a standard 5-field cron expression (or @daily/@hourly/@weekly/@monthly). */
export function parseCronExpression(expr: string): ParsedCronExpression {
	if (typeof expr !== "string") throw new Error("Cron expression must be a string");
	const trimmed = expr.trim();
	const expanded = CRON_ALIASES[trimmed.toLowerCase()] ?? trimmed;
	const parts = expanded.split(/\s+/);
	if (parts.length !== 5) {
		throw new Error("Cron expression must have 5 fields: minute hour day-of-month month day-of-week");
	}
	return {
		normalized: parts.join(" "),
		minute: parseCronField(parts[0], 0, 59),
		hour: parseCronField(parts[1], 0, 23),
		dom: parseCronField(parts[2], 1, 31),
		month: parseCronField(parts[3], 1, 12, { names: MONTH_NAMES }),
		dow: parseCronField(parts[4], 0, 7, { names: DOW_NAMES, wrapSeven: true }),
	};
}

/** Validate and normalize any AutomationSchedule definition. */
export function validateSchedule(raw: unknown): AutomationSchedule {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error("Invalid schedule");
	}
	const s = raw as Record<string, unknown>;
	switch (s.kind) {
		case "interval": {
			const every = Number(s.every);
			const unit = s.unit === "hours" ? "hours" : s.unit === "minutes" ? "minutes" : null;
			if (!unit) throw new Error("Interval unit must be 'minutes' or 'hours'");
			const max = unit === "minutes" ? 525_600 : 8_760;
			if (!Number.isInteger(every) || every < 1 || every > max) {
				throw new Error(`Interval value must be an integer between 1 and ${max}`);
			}
			return { kind: "interval", every, unit };
		}
		case "daily": {
			const parsed = parseTimeHHMM(s.time);
			if (!parsed) throw new Error("Daily time must use HH:MM (00:00–23:59)");
			return { kind: "daily", time: parsed.normalized };
		}
		case "weekly": {
			const parsed = parseTimeHHMM(s.time);
			if (!parsed) throw new Error("Weekly time must use HH:MM (00:00–23:59)");
			if (!Array.isArray(s.days) || s.days.length === 0) {
				throw new Error("Weekly schedule requires at least one weekday (0–6)");
			}
			const days = Array.from(
				new Set(
					s.days.map((d) => {
						const n = Number(d);
						if (!Number.isInteger(n) || n < 0 || n > 6) throw new Error("Weekday must be 0 (Sun) through 6 (Sat)");
						return n;
					}),
				),
			).sort((a, b) => a - b);
			return { kind: "weekly", days, time: parsed.normalized };
		}
		case "cron": {
			const parsed = parseCronExpression(String(s.expr ?? ""));
			return { kind: "cron", expr: parsed.normalized };
		}
		default:
			throw new Error(`Unsupported schedule kind: ${String(s.kind)}`);
	}
}

function cronMatchesDay(parsed: ParsedCronExpression, date: Date): boolean {
	const month = date.getMonth() + 1;
	if (!parsed.month.values.has(month)) return false;
	const domMatch = parsed.dom.values.has(date.getDate());
	const dowMatch = parsed.dow.values.has(date.getDay());
	if (!parsed.dom.isWildcard && !parsed.dow.isWildcard) {
		return domMatch || dowMatch;
	}
	return domMatch && dowMatch;
}

/**
 * Compute the next strictly future execution timestamp (epoch ms) after `fromMs`.
 * Always skips missed past occurrences when computing from `Date.now()`.
 */
export function computeNextRunAt(schedule: AutomationSchedule, fromMs = Date.now()): number | null {
	const normalized = validateSchedule(schedule);
	switch (normalized.kind) {
		case "interval": {
			const unitMs = normalized.unit === "hours" ? 3_600_000 : 60_000;
			return fromMs + normalized.every * unitMs;
		}
		case "daily": {
			const time = parseTimeHHMM(normalized.time)!;
			const base = new Date(fromMs);
			for (let offset = 0; offset <= 3; offset += 1) {
				const candidate = new Date(base.getFullYear(), base.getMonth(), base.getDate() + offset, time.hour, time.minute, 0, 0);
				if (candidate.getHours() === time.hour && candidate.getMinutes() === time.minute && candidate.getTime() > fromMs) return candidate.getTime();
			}
			return null;
		}
		case "weekly": {
			const time = parseTimeHHMM(normalized.time)!;
			const daySet = new Set(normalized.days);
			const base = new Date(fromMs);
			for (let offset = 0; offset <= 14; offset += 1) {
				const candidate = new Date(base.getFullYear(), base.getMonth(), base.getDate() + offset, time.hour, time.minute, 0, 0);
				if (candidate.getHours() === time.hour && candidate.getMinutes() === time.minute && daySet.has(candidate.getDay()) && candidate.getTime() > fromMs) {
					return candidate.getTime();
				}
			}
			return null;
		}
		case "cron": {
			const parsed = parseCronExpression(normalized.expr);
			const startMs = Math.floor(fromMs / 60_000) * 60_000 + 60_000;
			const start = new Date(startMs);
			for (let dayOffset = 0; dayOffset <= MAX_LOOKAHEAD_DAYS; dayOffset += 1) {
				const dayStart = new Date(start.getFullYear(), start.getMonth(), start.getDate() + dayOffset, 0, 0, 0, 0);
				if (!cronMatchesDay(parsed, dayStart)) continue;
				const nextDay = new Date(dayStart.getFullYear(), dayStart.getMonth(), dayStart.getDate() + 1);
				const repeatedMs = Math.max(0, nextDay.getTimezoneOffset() - dayStart.getTimezoneOffset()) * 60_000;
				let earliest = Infinity;
				for (const hour of parsed.hour.sorted) {
					for (const minute of parsed.minute.sorted) {
						const candidate = new Date(dayStart.getFullYear(), dayStart.getMonth(), dayStart.getDate(), hour, minute, 0, 0);
						// Fall-back days can contain this wall-clock time twice. Compare
						// both instants; civil hour/minute ordering is not chronological.
						for (const ts of repeatedMs ? [candidate.getTime(), candidate.getTime() + repeatedMs] : [candidate.getTime()]) {
							const occurrence = new Date(ts);
							if (ts > fromMs && occurrence.getDate() === dayStart.getDate() && occurrence.getHours() === hour && occurrence.getMinutes() === minute) earliest = Math.min(earliest, ts);
						}
					}
				}
				if (earliest < Infinity) return earliest;
			}
			return null;
		}
	}
}

const WEEKDAY_LABELS: Record<Lang, string[]> = {
	zh: ["周日", "周一", "周二", "周三", "周四", "周五", "周六"],
	"zh-Hant": ["週日", "週一", "週二", "週三", "週四", "週五", "週六"],
	en: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
	ja: ["日曜", "月曜", "火曜", "水曜", "木曜", "金曜", "土曜"],
	ru: ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"],
};

/** Human-readable schedule summary suitable for UI cards and dropdowns. */
export function describeSchedule(schedule: AutomationSchedule, lang: Lang): string {
	switch (schedule.kind) {
		case "interval": {
			const hours = schedule.unit === "hours";
			if (lang === "zh") return `每 ${schedule.every} ${hours ? "小时" : "分钟"}`;
			if (lang === "zh-Hant") return `每 ${schedule.every} ${hours ? "小時" : "分鐘"}`;
			if (lang === "ja") return `${schedule.every} ${hours ? "時間" : "分"}ごと`;
			if (lang === "ru") return `Каждые ${schedule.every} ${hours ? "ч" : "мин"}`;
			return `Every ${schedule.every} ${schedule.every === 1 ? schedule.unit.slice(0, -1) : schedule.unit}`;
		}
		case "daily":
			if (lang === "zh" || lang === "zh-Hant") return `每天 ${schedule.time}`;
			if (lang === "ja") return `毎日 ${schedule.time}`;
			if (lang === "ru") return `Ежедневно в ${schedule.time}`;
			return `Daily at ${schedule.time}`;
		case "weekly": {
			const names = schedule.days.map((d) => WEEKDAY_LABELS[lang][d] ?? String(d)).join(lang === "zh" || lang === "zh-Hant" ? "、" : ", ");
			if (lang === "zh" || lang === "zh-Hant") return `每${names} ${schedule.time}`;
			if (lang === "ja") return `毎週 ${names} ${schedule.time}`;
			if (lang === "ru") return `${names} в ${schedule.time}`;
			return `${names} at ${schedule.time}`;
		}
		case "cron":
			return `Cron: ${schedule.expr}`;
	}
}
