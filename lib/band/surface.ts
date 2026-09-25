/**
 * Backgrounds behind whole blocks of lines: the gray a tool row's body sits
 * on beneath its band, and the lighter panel a popup is drawn on. Both come
 * from the theme's pending tool background, so any theme gets them in its
 * own colors.
 */
import { bgSgr, mix, parseAnsiColor } from "./color.ts";
import { paletteFrom, type BandTheme } from "./palette.ts";
import { visibleWidth } from "@earendil-works/pi-tui";

// How far a popup panel leans from the tool body gray toward the muted text color.
const PANEL_LIFT = 0.1;

const RESET = /\x1b\[0?m|\x1b\[49m/g;

/** Pads each line to `width` on the background, re-opening it after any reset inside the line. */
export function onBackground(lines: readonly string[], width: number, sgr: string | undefined): string[] {
	if (!sgr) return [...lines];
	return lines.map((line) => {
		const pad = " ".repeat(Math.max(0, width - visibleWidth(line)));
		return `${sgr}${line.replace(RESET, (reset) => (reset === "\x1b[49m" ? sgr : `${reset}${sgr}`))}${pad}\x1b[49m`;
	});
}

function themeBg(theme: BandTheme, key: string): string | undefined {
	try {
		const sgr = theme.getBgAnsi(key);
		return parseAnsiColor(sgr) ? sgr : undefined;
	} catch {
		return undefined;
	}
}

/** The gray under a tool row's body; undefined when the theme leaves it to the terminal. */
export function bodyBackground(theme: BandTheme): string | undefined {
	return themeBg(theme, "toolPendingBg");
}

/** A popup's panel: a step lighter than tool bodies, so it reads as above them. */
export function panelBackground(theme: BandTheme): string | undefined {
	const palette = paletteFrom(theme);
	if (!palette) return themeBg(theme, "selectedBg");
	return bgSgr(mix(palette.base, palette.muted, PANEL_LIFT), palette.mode);
}
