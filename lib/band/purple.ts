/** Pi's custom-message purple, shared by compaction and cross-agent mail. */
import { renderBand, type BandSpec } from "./band.ts";
import { mix, parseAnsiColor } from "./color.ts";
import { paletteFrom, type BandTheme, type Palette } from "./palette.ts";
import { bodyBackground } from "./surface.ts";

// The header leans from Pi's purple surface toward its violet label.
const PURPLE_TINT = 0.22;
type PurpleTheme = BandTheme & { bold(text: string): string };

export function purpleBackground(theme: BandTheme): string | undefined {
	try {
		const sgr = theme.getBgAnsi("customMessageBg");
		return parseAnsiColor(sgr) ? sgr : bodyBackground(theme);
	} catch { return bodyBackground(theme); }
}

export function purplePalette(theme: BandTheme): Palette | undefined {
	try {
		const palette = paletteFrom(theme);
		const bg = parseAnsiColor(theme.getBgAnsi("customMessageBg"));
		const hue = parseAnsiColor(theme.getFgAnsi("customMessageLabel"));
		return palette && bg && hue ? { ...palette, ok: mix(bg, hue, PURPLE_TINT) } : undefined;
	} catch { return undefined; }
}

/** Finished bands fall back to the custom surface, not the green success background. */
export function purpleTheme(theme: PurpleTheme): PurpleTheme {
	return {
		...theme,
		fg: (key, text) => {
			const painted = theme.fg(key, text);
			return key === "customMessageLabel" ? theme.bold(painted) : painted;
		},
		bg: (key, text) => theme.bg(key === "toolSuccessBg" ? "customMessageBg" : key, text),
		getFgAnsi: (key) => theme.getFgAnsi(key),
		getBgAnsi: (key) => theme.getBgAnsi(key),
		getColorMode: () => theme.getColorMode(),
		bold: (text) => theme.bold(text),
	};
}

/** Comms keep their identity tint; delivery failures and questions use colored rail words. */
export function renderPurpleBand(theme: PurpleTheme, spec: BandSpec): string {
	return renderBand(purpleTheme(theme), purplePalette(theme), {
		...spec, phase: { kind: "done", outcome: "ok", sinceMs: Infinity }, marginPhase: spec.marginPhase ?? spec.phase,
	});
}
