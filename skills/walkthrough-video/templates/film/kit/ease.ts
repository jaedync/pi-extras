/**
 * CSS curves as GSAP eases, solved the way the browser solves them, so a
 * film moves on the product's own curves (wv lift finds them in its CSS).
 */
import type { Curve } from "./types.ts";

export type EaseFn = (progress: number) => number;

/** The CSS cubic-bezier(x1, y1, x2, y2) timing function. */
export function bezier(x1: number, y1: number, x2: number, y2: number): EaseFn {
	const cx = 3 * x1;
	const bx = 3 * (x2 - x1) - cx;
	const ax = 1 - cx - bx;
	const cy = 3 * y1;
	const by = 3 * (y2 - y1) - cy;
	const ay = 1 - cy - by;
	const X = (t: number) => ((ax * t + bx) * t + cx) * t;
	const Y = (t: number) => ((ay * t + by) * t + cy) * t;
	const dX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
	return (x: number) => {
		if (x <= 0) return 0;
		if (x >= 1) return 1;
		let t = x;
		for (let i = 0; i < 8; i++) {
			const e = X(t) - x;
			const d = dX(t);
			if (Math.abs(e) < 1e-6 || Math.abs(d) < 1e-6) break;
			t -= e / d;
		}
		if (Math.abs(X(t) - x) > 1e-5) {
			let lo = 0;
			let hi = 1;
			t = x;
			for (let i = 0; i < 30; i++) {
				if (X(t) < x) lo = t;
				else hi = t;
				t = (lo + hi) / 2;
			}
		}
		return Y(t);
	};
}

/**
 * An ease-out for a camera drift that never comes to rest: a blend of a
 * quadratic ease-out and a straight line, so it leaves the cut at (2 - floor)
 * times the mean speed and ends at `floor` times it. A plain ease-out stops
 * in its last 0.2 s, and wv check then reads the end of the shot as a freeze.
 */
export function driftOut(floor = 0.4): EaseFn {
	return (x: number) => {
		if (x <= 0) return 0;
		if (x >= 1) return 1;
		return floor * x + (1 - floor) * (1 - (1 - x) * (1 - x));
	};
}

/** The four numbers of a "cubic-bezier(...)" string, or null. */
export function parseCurve(css: string): Curve | null {
	const m = /cubic-bezier\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)/.exec(css);
	return m ? [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])] : null;
}

/** The CSS keyword curves, so a scene can say ease.inOut and mean what CSS means. */
export const CSS_CURVES: Record<string, Curve> = {
	std: [0.4, 0, 0.2, 1],
	out: [0, 0, 0.58, 1],
	in: [0.42, 0, 1, 1],
	inOut: [0.42, 0, 0.58, 1],
	// A soft out-curve for text that arrives and settles (expo-like).
	settle: [0.16, 1, 0.3, 1],
};
