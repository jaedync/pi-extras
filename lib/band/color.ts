/**
 * Color math for bands: theme colors read back from the escapes Pi's theme
 * emits, mixed in RGB, and written as truecolor or the nearest xterm-256
 * entry, whichever the terminal uses.
 */

export type Rgb = readonly [number, number, number];
export type ColorMode = "truecolor" | "256color";

const CUBE = [0, 95, 135, 175, 215, 255];
// xterm's defaults for the 16 system colors; terminals may remap them, so they are never picked as a mix result.
const SYSTEM: Rgb[] = [
	[0, 0, 0], [205, 0, 0], [0, 205, 0], [205, 205, 0], [0, 0, 238], [205, 0, 205], [0, 205, 205], [229, 229, 229],
	[127, 127, 127], [255, 0, 0], [0, 255, 0], [255, 255, 0], [92, 92, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255],
];

export function ansi256ToRgb(index: number): Rgb {
	if (index < 16) return SYSTEM[index] ?? [0, 0, 0];
	if (index >= 232) {
		const level = 8 + (index - 232) * 10;
		return [level, level, level];
	}
	const cube = index - 16;
	return [CUBE[Math.floor(cube / 36)]!, CUBE[Math.floor(cube / 6) % 6]!, CUBE[cube % 6]!];
}

/** The RGB value of a `38;2`, `48;2`, `38;5` or `48;5` escape; undefined for defaults and anything else. */
export function parseAnsiColor(sgr: string): Rgb | undefined {
	const truecolor = /\x1b\[[34]8;2;(\d{1,3});(\d{1,3});(\d{1,3})m/.exec(sgr);
	if (truecolor) return [Number(truecolor[1]), Number(truecolor[2]), Number(truecolor[3])];
	const indexed = /\x1b\[[34]8;5;(\d{1,3})m/.exec(sgr);
	return indexed ? ansi256ToRgb(Number(indexed[1])) : undefined;
}

export function mix(from: Rgb, to: Rgb, amount: number): Rgb {
	const t = Math.min(1, Math.max(0, amount));
	return [0, 1, 2].map((index) => Math.round(from[index]! + (to[index]! - from[index]!) * t)) as unknown as Rgb;
}

const distance = (a: Rgb, b: Rgb) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

function nearestLevel(value: number): number {
	let best = 0;
	for (let index = 1; index < CUBE.length; index++) if (Math.abs(CUBE[index]! - value) < Math.abs(CUBE[best]! - value)) best = index;
	return best;
}

/** The closest color-cube or grayscale entry. */
export function rgbTo256(rgb: Rgb): number {
	const [r, g, b] = rgb.map(nearestLevel) as [number, number, number];
	const cube = 16 + r * 36 + g * 6 + b;
	const grayStep = Math.min(23, Math.max(0, Math.round(((rgb[0] + rgb[1] + rgb[2]) / 3 - 8) / 10)));
	const gray = 232 + grayStep;
	return distance(ansi256ToRgb(gray), rgb) < distance(ansi256ToRgb(cube), rgb) ? gray : cube;
}

export function bgSgr(rgb: Rgb, mode: ColorMode): string {
	return mode === "truecolor" ? `\x1b[48;2;${rgb[0]};${rgb[1]};${rgb[2]}m` : `\x1b[48;5;${rgbTo256(rgb)}m`;
}

export function fgSgr(rgb: Rgb, mode: ColorMode): string {
	return mode === "truecolor" ? `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m` : `\x1b[38;5;${rgbTo256(rgb)}m`;
}
