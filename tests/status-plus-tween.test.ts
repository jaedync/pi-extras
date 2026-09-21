import { test } from "node:test";
import assert from "node:assert/strict";
import { FALL_MS, HOLD_MS, RISE_MS, TWEEN_MS, flashIntensity, incrementAt, isActive, retarget, valueAt } from "../lib/status-plus-tween.ts";

test("first sight of a value is already settled, so a resumed session does not animate", () => {
	const tween = retarget(undefined, 2.5, 1000);
	assert.equal(valueAt(tween, 1000), 2.5);
	assert.equal(isActive(tween, 1000), false);
	assert.equal(flashIntensity(tween, 1000), 0);
});

test("a new target eases from the old value and the number is final at the end of its window", () => {
	const settled = retarget(undefined, 1, 0);
	const tween = retarget(settled, 2, 1000);
	assert.equal(valueAt(tween, 1000), 1);
	const mid = valueAt(tween, 1000 + TWEEN_MS / 2);
	assert.ok(mid > 1.5 && mid < 2, `ease-out passes halfway early: ${mid}`);
	assert.equal(valueAt(tween, 1000 + TWEEN_MS), 2);
	assert.equal(valueAt(tween, 1000 + 5 * TWEEN_MS), 2, "never overshoots");
});

test("flash rises fast, holds until the final number has been visible, then falls, then stops", () => {
	const settled = retarget(undefined, 1, 0);
	const tween = retarget(settled, 2, 1000);
	const at = (ms: number) => flashIntensity(tween, 1000 + ms);
	assert.equal(at(0), 0, "starts from nothing");
	assert.ok(at(RISE_MS / 2) > 0 && at(RISE_MS / 2) < 1, "rising");
	// Full red while the number moves and for HOLD_MS after it is final.
	for (const ms of [RISE_MS, TWEEN_MS / 2, TWEEN_MS, TWEEN_MS + HOLD_MS - 1]) assert.equal(at(ms), 1, `held at ${ms}`);
	assert.equal(valueAt(tween, 1000 + TWEEN_MS + HOLD_MS), 2, "number already final when the fade starts");
	const fading = at(TWEEN_MS + HOLD_MS + FALL_MS / 2);
	assert.ok(fading > 0 && fading < 1, "falling");
	assert.ok(at(TWEEN_MS + HOLD_MS + FALL_MS * 0.9) < fading, "still falling");
	assert.equal(at(TWEEN_MS + HOLD_MS + FALL_MS), 0, "gone");
	// Frames keep coming through the whole flash, then stop.
	assert.equal(isActive(tween, 1000 + TWEEN_MS + HOLD_MS + FALL_MS - 1), true);
	assert.equal(isActive(tween, 1000 + TWEEN_MS + HOLD_MS + FALL_MS), false);
});

test("unchanged targets reuse the tween; a burst restarts number and flash from where they are", () => {
	const settled = retarget(undefined, 1, 0);
	const tween = retarget(settled, 2, 1000);
	assert.equal(retarget(tween, 2, 1200), tween);
	const burst = retarget(tween, 3, 1000 + TWEEN_MS / 2);
	assert.equal(burst.from, valueAt(tween, 1000 + TWEEN_MS / 2));
	assert.equal(burst.to, 3);
	assert.equal(burst.startMs, 1000 + TWEEN_MS / 2);
	assert.equal(burst.flashFrom, 1, "already fully red, so no dip at the restart");
	assert.equal(flashIntensity(burst, burst.startMs), 1);
	assert.deepEqual(tween, { from: 1, to: 2, startMs: 1000, durationMs: TWEEN_MS, flashFrom: 0, delta: 1 }, "inputs are never mutated");
});

test("increments track target changes, not unfinished animation, and expire with the flash", () => {
	const baseline = retarget(undefined, 1, 0);
	assert.equal(incrementAt(baseline, 0), undefined);
	const first = retarget(baseline, 2, 1000);
	const next = retarget(first, 2.00093, 1200);
	assert.ok(Math.abs(incrementAt(next, 1200)! - 0.00093) < 1e-12);
	assert.equal(incrementAt(retarget(next, next.to, 1300), 1300), next.delta);
	assert.equal(incrementAt(next, 1200 + TWEEN_MS + HOLD_MS + FALL_MS - 1), next.delta);
	assert.equal(incrementAt(next, 1200 + TWEEN_MS + HOLD_MS + FALL_MS), undefined);
	assert.equal(incrementAt(retarget(next, 0.5, 1400), 1400), undefined);
	assert.equal(incrementAt(retarget(undefined, 20, 1400), 1400), undefined);
});

test("a retarget during the fade resumes the flash from its current level, never from zero", () => {
	const settled = retarget(undefined, 1, 0);
	const tween = retarget(settled, 2, 1000);
	const midFade = 1000 + TWEEN_MS + HOLD_MS + FALL_MS / 2;
	const level = flashIntensity(tween, midFade);
	assert.ok(level > 0 && level < 1);
	const again = retarget(tween, 2.5, midFade);
	assert.equal(again.flashFrom, level);
	assert.equal(flashIntensity(again, midFade), level, "continuous at the handover");
	const shortly = flashIntensity(again, midFade + RISE_MS / 2);
	assert.ok(shortly > level && shortly < 1, "rises again from that level");
	assert.equal(flashIntensity(again, midFade + RISE_MS), 1);
	// After the fade has fully finished, a fresh change starts from zero again.
	const later = retarget(tween, 4, 1000 + TWEEN_MS + HOLD_MS + FALL_MS + 5000);
	assert.equal(later.flashFrom, 0);
	assert.equal(later.from, 2, "number starts from the settled value");
});
