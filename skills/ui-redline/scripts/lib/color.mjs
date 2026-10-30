/**
 * Color math for the rules. The collector converts every CSS color to sRGB
 * bytes in the page (through a canvas), so these functions take plain
 * [r, g, b, a] arrays: r, g and b from 0 to 255, a from 0 to 1.
 */

/** Chroma (OKLCH C) above which a color reads as a hue, not a tinted grey. */
export const CHROMATIC = 0.08;
/** Below this chroma a color is a neutral, also when it has a faint tint. */
export const NEUTRAL = 0.04;

const toLinear = (channel) => {
	const c = channel / 255;
	return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

/** WCAG 2 relative luminance of an opaque color. */
export function luminance([r, g, b]) {
	return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/** WCAG 2 contrast ratio of two opaque colors, from 1 to 21. */
export function contrastRatio(fg, bg) {
	const a = luminance(fg);
	const b = luminance(bg);
	return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** `top` drawn over the opaque `bottom`, as an opaque color. */
export function composite(top, bottom) {
	const alpha = top[3] ?? 1;
	return [0, 1, 2].map((i) => top[i] * alpha + bottom[i] * (1 - alpha)).concat(1);
}

/** OKLab of an sRGB color (Björn Ottosson's matrices). */
export function oklab([r, g, b]) {
	const [lr, lg, lb] = [r, g, b].map(toLinear);
	const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
	const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
	const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
	return [
		0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
		1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
		0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
	];
}

/** OKLCH as { l, c, h }, h in degrees from 0 to 360. */
export function oklch(rgb) {
	const [l, a, b] = oklab(rgb);
	const h = (Math.atan2(b, a) * 180) / Math.PI;
	return { l, c: Math.hypot(a, b), h: h < 0 ? h + 360 : h };
}

/** Euclidean distance in OKLab: about 0.02 is the smallest step people notice. */
export function distance(x, y) {
	const [a, b] = [oklab(x), oklab(y)];
	return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** True when the color is visible and has a clear hue. */
export function isChromatic(rgba, min = CHROMATIC) {
	return (rgba[3] ?? 1) >= 0.1 && oklch(rgba).c >= min;
}

/** The smallest arc of the hue circle that holds every hue, in degrees. */
export function hueSpread(hues) {
	if (hues.length < 2) return 0;
	const sorted = [...hues].sort((a, b) => a - b);
	let largestGap = 360 - sorted[sorted.length - 1] + sorted[0];
	for (let i = 1; i < sorted.length; i++) largestGap = Math.max(largestGap, sorted[i] - sorted[i - 1]);
	return 360 - largestGap;
}

/** Groups colors that people see as the same; returns one representative per group with its count. */
export function clusterColors(colors, threshold = 0.03) {
	const groups = [];
	for (const color of colors) {
		const group = groups.find((g) => distance(g.color, color) < threshold);
		if (group) group.count++;
		else groups.push({ color, count: 1 });
	}
	return groups.sort((a, b) => b.count - a.count);
}

/** #rrggbb, or #rrggbbaa when the color is not opaque. */
export function hex(rgba) {
	const part = (n) => Math.round(n).toString(16).padStart(2, "0");
	const alpha = rgba[3] ?? 1;
	return `#${part(rgba[0])}${part(rgba[1])}${part(rgba[2])}${alpha < 1 ? part(alpha * 255) : ""}`;
}
