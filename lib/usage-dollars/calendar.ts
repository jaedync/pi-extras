/**
 * Day and month arithmetic in one time zone, for "spent today" and monthly
 * pacing. Days are local calendar dates; resets are instants.
 */
import { dateFormat } from "../date-format.ts";

const DAY_MS = 86_400_000;
// A monthly reset is at most about 31 days away; the cap only stops a bad instant from looping.
const MAX_DAYS_SCANNED = 400;

interface LocalParts {
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
	second: number;
}

function localParts(epochMs: number, timeZone: string): LocalParts {
	const parts = dateFormat("calendar-parts", timeZone, {
		year: "numeric", month: "2-digit", day: "2-digit",
		hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
	}).formatToParts(new Date(epochMs));
	const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
	return { year: value("year"), month: value("month"), day: value("day"), hour: value("hour"), minute: value("minute"), second: value("second") };
}

/** Local wall time minus UTC at this instant. */
function offsetMs(epochMs: number, timeZone: string): number {
	const p = localParts(epochMs, timeZone);
	return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(epochMs / 1000) * 1000;
}

/** Local calendar date as a UTC-midnight day number, for counting and weekday checks. */
function localDayNumber(epochMs: number, timeZone: string): number {
	const p = localParts(epochMs, timeZone);
	return Date.UTC(p.year, p.month - 1, p.day) / DAY_MS;
}

export function localDateKey(epochMs: number, timeZone: string): string {
	return new Date(localDayNumber(epochMs, timeZone) * DAY_MS).toISOString().slice(0, 10);
}

/** A clock change moves local time by at most this much, so a day's first instant is within it of the estimate. */
const MAX_SHIFT_MS = 3 * 3_600_000;

/** The first instant in (low, high] whose local date is at least `day`; local dates only rise across a clock change. */
function firstOf(day: number, low: number, high: number, timeZone: string): number {
	while (high - low > 1) {
		const mid = Math.floor((low + high) / 2);
		if (localDayNumber(mid, timeZone) >= day) high = mid;
		else low = mid;
	}
	return high;
}

/**
 * The instant the local day containing epochMs began. The offset at local
 * midnight can differ from the offset now on a DST day; a second pass settles
 * it. Where DST begins at midnight (Havana, Santiago), there is no 00:00: the
 * estimate lands in the day before, and the day begins at the change.
 */
export function localDayStartMs(epochMs: number, timeZone: string): number {
	const day = localDayNumber(epochMs, timeZone);
	const midnight = day * DAY_MS;
	const estimate = midnight - offsetMs(midnight - offsetMs(midnight, timeZone), timeZone);
	if (localDayNumber(estimate, timeZone) < day) return firstOf(day, estimate, Math.min(epochMs, estimate + MAX_SHIFT_MS), timeZone);
	if (localDayNumber(estimate - 1, timeZone) === day) return firstOf(day, Math.max(estimate - MAX_SHIFT_MS, epochMs - DAY_MS - MAX_SHIFT_MS), estimate, timeZone);
	return estimate;
}

/** Local dates from today through the day that holds the last moment before the reset. */
function daysUntil(nowMs: number, resetMs: number, timeZone: string): number[] {
	if (!Number.isFinite(nowMs) || !Number.isFinite(resetMs) || resetMs <= nowMs) return [];
	const first = localDayNumber(nowMs, timeZone);
	const last = Math.min(localDayNumber(resetMs - 1, timeZone), first + MAX_DAYS_SCANNED);
	const days: number[] = [];
	for (let day = first; day <= last; day += 1) days.push(day);
	return days;
}

export function calendarDaysLeft(nowMs: number, resetMs: number, timeZone: string): number {
	return daysUntil(nowMs, resetMs, timeZone).length;
}

const isWeekday = (day: number): boolean => {
	const weekday = new Date(day * DAY_MS).getUTCDay();
	return weekday !== 0 && weekday !== 6;
};

/** Monday to Friday in the local time zone. Holidays are not known. */
export function isBusinessDay(epochMs: number, timeZone: string): boolean {
	return isWeekday(localDayNumber(epochMs, timeZone));
}

/** Monday to Friday, today included when it is one. */
export function businessDaysLeft(nowMs: number, resetMs: number, timeZone: string): number {
	return daysUntil(nowMs, resetMs, timeZone).filter(isWeekday).length;
}

/** Monthly provider meters that report no reset are assumed to roll over with the UTC month. */
export function nextUtcMonthStartMs(epochMs: number): number {
	const date = new Date(epochMs);
	return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
}
