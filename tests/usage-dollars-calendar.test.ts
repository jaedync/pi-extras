import { test } from "node:test";
import assert from "node:assert/strict";
import { businessDaysLeft, calendarDaysLeft, localDateKey, localDayStartMs, nextUtcMonthStartMs } from "../lib/usage-dollars/calendar.ts";

const CHICAGO = "America/Chicago";
// Saturday 2026-10-10 12:00 CDT (UTC-5).
const SAT_NOON = Date.UTC(2026, 9, 10, 17, 0);
// Monday 2026-10-12 09:00 CDT.
const MON_MORNING = Date.UTC(2026, 9, 12, 14, 0);
const NOV_1_UTC = Date.UTC(2026, 10, 1);

test("local date key and day start follow the time zone, not UTC", () => {
	// 23:30 CDT on Oct 10 is already Oct 11 in UTC.
	const late = Date.UTC(2026, 9, 11, 4, 30);
	assert.equal(localDateKey(late, CHICAGO), "2026-10-10");
	assert.equal(localDayStartMs(late, CHICAGO), Date.UTC(2026, 9, 10, 5, 0));
	assert.equal(localDateKey(late, "UTC"), "2026-10-11");
	assert.equal(localDayStartMs(late, "UTC"), Date.UTC(2026, 9, 11));
});

test("day start is correct on both daylight saving transitions", () => {
	// US DST ends Sunday 2026-11-01 at 02:00 CDT: midnight is still UTC-5.
	assert.equal(localDayStartMs(Date.UTC(2026, 10, 1, 18), CHICAGO), Date.UTC(2026, 10, 1, 5));
	// The day after, midnight is UTC-6.
	assert.equal(localDayStartMs(Date.UTC(2026, 10, 2, 18), CHICAGO), Date.UTC(2026, 10, 2, 6));
	// DST starts Sunday 2027-03-14: midnight is UTC-6, noon is UTC-5.
	assert.equal(localDayStartMs(Date.UTC(2027, 2, 14, 17), CHICAGO), Date.UTC(2027, 2, 14, 6));
});

test("business days left counts weekdays from today through the reset day", () => {
	// Sat Oct 10 -> the reset at Nov 1 00:00 UTC is Oct 31 19:00 CDT, a Saturday.
	// Weekdays Oct 12-16, 19-23, 26-30 = 15.
	assert.equal(businessDaysLeft(SAT_NOON, NOV_1_UTC, CHICAGO), 15);
	// Monday counts itself.
	assert.equal(businessDaysLeft(MON_MORNING, NOV_1_UTC, CHICAGO), 15);
	// In UTC the reset instant itself starts Nov 1, so Oct 31 is the last day: same count.
	assert.equal(businessDaysLeft(MON_MORNING, NOV_1_UTC, "UTC"), 15);
});

test("calendar days left includes today and the reset day", () => {
	assert.equal(calendarDaysLeft(SAT_NOON, NOV_1_UTC, CHICAGO), 22);
	assert.equal(calendarDaysLeft(SAT_NOON, SAT_NOON + 60_000, CHICAGO), 1);
});

test("a reset in the past or a malformed instant leaves zero days", () => {
	assert.equal(businessDaysLeft(MON_MORNING, MON_MORNING - 1, CHICAGO), 0);
	assert.equal(calendarDaysLeft(MON_MORNING, Number.NaN, CHICAGO), 0);
});

test("next UTC month start rolls the year over", () => {
	assert.equal(nextUtcMonthStartMs(SAT_NOON), NOV_1_UTC);
	assert.equal(nextUtcMonthStartMs(Date.UTC(2026, 11, 31, 23)), Date.UTC(2027, 0, 1));
});
