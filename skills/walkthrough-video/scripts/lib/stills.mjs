/**
 * Which frames of a capture repeat the image before them. The pump writes one
 * frame per wall-clock slot and the same image again for every slot the app
 * missed, so a busy host or a slow canvas fills the capture with repeated
 * images. This tracker keeps the runs of them as flat [from, to] frame ranges
 * (both ends included), which the composer compresses and the smoothness gate
 * measures. Kept small and pure: the pump calls add() once per written frame.
 */
export class StillTracker {
	constructor() {
		this.list = [];
		this.open = null;
		this.still = 0;
		this.distinct = 0;
		this.prev = null;
	}

	/** One written frame: `hash` is the image's digest, `frame` its index in the video. */
	add(hash, frame) {
		const same = this.prev !== null && hash === this.prev;
		this.prev = hash;
		if (!same) {
			this.distinct++;
			this.open = null;
			return;
		}
		this.still++;
		if (this.open) this.open[1] = frame;
		else {
			this.open = [frame, frame];
			this.list.push(this.open);
		}
	}

	/** The runs, as [from, to] pairs. A run still open ends at the last frame added. */
	runs() {
		return this.list.map(([from, to]) => [from, to]);
	}

	/** Frames that repeat the image before them. */
	stillFrames() {
		return this.still;
	}

	/** Frames that show a new image. */
	distinctFrames() {
		return this.distinct;
	}
}

/** The runs of a capture's events.json, or an empty list for a capture that has none. */
export function stillRuns(capture) {
	const list = capture?.stills;
	if (!Array.isArray(list)) return [];
	return list.filter((run) => Array.isArray(run) && Number.isFinite(run[0]) && Number.isFinite(run[1]) && run[1] >= run[0]);
}

/** How many frames of [from, to] repeat the image before them. */
export function stillFramesIn(stills, from, to) {
	let count = 0;
	for (const [a, b] of stills ?? []) {
		if (b < from || a > to) continue;
		count += Math.min(b, to) - Math.max(a, from) + 1;
	}
	return count;
}
