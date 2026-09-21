/**
 * Counter animation for the footer's spend cell. When the session total
 * moves, the displayed figure eases from the old value to the new one, and
 * the cell wears a flash tone that rises quickly, stays at full strength
 * until the final figure has been on screen for a moment, then fades out.
 *
 * Timeline from a change at t=0:
 *
 *   0 ......... RISE_MS            flash rises (from wherever it already was)
 *   0 ......... durationMs         number eases to the target
 *   durationMs .. + HOLD_MS        number is final; flash stays full
 *   then ...... + FALL_MS          flash fades to nothing
 *
 * Pure: every function returns a new value and the caller owns the clock.
 */
export interface Tween {
	from: number;
	to: number;
	startMs: number;
	/** Window for the number itself; the flash outlives it by HOLD_MS + FALL_MS. */
	durationMs: number;
	/** Flash intensity at the moment this tween began, so a retarget mid-flash never dips. */
	flashFrom: number;
	/** Actual target-to-target charge, independent of the eased display position. */
	delta: number;
}

export const TWEEN_MS = 1000;
export const RISE_MS = 120;
export const HOLD_MS = 350;
export const FALL_MS = 350;
/** Render cadence while a tween is live; coarse enough to be cheap, fine enough to read as motion. */
export const TWEEN_FRAME_MS = 50;

const smoothstep = (x: number): number => {
	const t = Math.min(1, Math.max(0, x));
	return t * t * (3 - 2 * t);
};

function easeOutCubic(t: number): number {
	const u = 1 - t;
	return 1 - u * u * u;
}

/** Total time the tween keeps frames coming: number window plus the flash tail. */
function lifetimeMs(tween: Tween): number {
	return tween.durationMs + HOLD_MS + FALL_MS;
}

export function valueAt(tween: Tween, nowMs: number): number {
	if (tween.durationMs <= 0) return tween.to;
	const t = Math.min(1, Math.max(0, (nowMs - tween.startMs) / tween.durationMs));
	return tween.from + (tween.to - tween.from) * easeOutCubic(t);
}

export function isActive(tween: Tween | undefined, nowMs: number): boolean {
	return Boolean(tween) && tween!.from !== tween!.to && nowMs - tween!.startMs < lifetimeMs(tween!);
}

/** Keep the latest positive charge visible for the whole animation, including its fade. */
export function incrementAt(tween: Tween | undefined, nowMs: number): number | undefined {
	return tween && tween.delta > 0 && isActive(tween, nowMs) ? tween.delta : undefined;
}

/** How strongly the flash colour should show, 0 to 1; zero once settled. */
export function flashIntensity(tween: Tween | undefined, nowMs: number): number {
	if (!tween || !isActive(tween, nowMs)) return 0;
	const elapsed = nowMs - tween.startMs;
	if (elapsed < RISE_MS) return tween.flashFrom + (1 - tween.flashFrom) * smoothstep(elapsed / RISE_MS);
	const fallStart = tween.durationMs + HOLD_MS;
	if (elapsed < fallStart) return 1;
	return 1 - smoothstep((elapsed - fallStart) / FALL_MS);
}

/**
 * Advance a tween toward `target`. Unchanged targets return the same object.
 * A new target starts the number from wherever the previous tween currently
 * sits and the flash from its current intensity, so a burst of updates never
 * snaps back or blinks: the figure keeps moving and stays red until the last
 * target has been final for HOLD_MS.
 */
export function retarget(tween: Tween | undefined, target: number, nowMs: number, durationMs = TWEEN_MS): Tween {
	if (!tween) return { from: target, to: target, startMs: nowMs - durationMs - HOLD_MS - FALL_MS, durationMs, flashFrom: 0, delta: 0 };
	if (tween.to === target) return tween;
	return { from: valueAt(tween, nowMs), to: target, startMs: nowMs, durationMs, flashFrom: flashIntensity(tween, nowMs), delta: target - tween.to };
}
