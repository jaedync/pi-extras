/**
 * The frame clock. Capture time is a count of slots at `fps`; each slot gets
 * exactly one image in the video, so a late screenshot repeats the last image
 * for the slots it missed and the video never drifts from the wall clock.
 */

export function slotFor(elapsedMs, fps) {
	return Math.floor((elapsedMs * fps) / 1000);
}

export function slotDueMs(slot, fps) {
	return (slot * 1000) / fps;
}

/**
 * Claims the next slot that is due. `take` returns null when no slot is due
 * (the caller would write an extra frame) and otherwise the missed-slot count
 * to fill with the last image.
 */
export class SlotClock {
	constructor(fps) {
		if (!(fps > 0)) throw new Error(`fps must be positive, got ${fps}`);
		this.fps = fps;
		/** The slot that the next capture will fill. Also the frame count taken so far, with repeats. */
		this.next = 0;
	}

	take(elapsedMs) {
		const slot = slotFor(elapsedMs, this.fps);
		if (slot < this.next) return null;
		const repeats = slot - this.next;
		this.next = slot + 1;
		return { slot, repeats };
	}
}
