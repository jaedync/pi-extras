/** The quiet theme's colors as a theme object, for tests that check real escapes. */
import type { PopupTheme } from "../../lib/band/popup.ts";

const hex = (value: string) => [1, 3, 5].map((index) => parseInt(value.slice(index, index + 2), 16));
const fgOf = (value: string) => { const [r, g, b] = hex(value); return `\x1b[38;2;${r};${g};${b}m`; };
const bgOf = (value: string) => { const [r, g, b] = hex(value); return `\x1b[48;2;${r};${g};${b}m`; };

export const FG: Record<string, string> = { accent: "#8fb4c8", success: "#8fae7a", error: "#c97a72", warning: "#ecb64e", muted: "#8a8882", dim: "#5f5d58", text: "#cfcdc6", toolTitle: "#8fb4c8", toolOutput: "#a8a69f", mdHeading: "#d8c89a", border: "#3a3936" };
export const BG: Record<string, string> = { toolPendingBg: "#232326", toolSuccessBg: "#212823", toolErrorBg: "#2b2224", selectedBg: "#2d2d31" };

export { bgOf, fgOf };

export function quiet(mode: "truecolor" | "256color" = "truecolor"): PopupTheme {
	return {
		getFgAnsi: (key) => (FG[key] ? fgOf(FG[key]!) : "\x1b[39m"),
		getBgAnsi: (key) => (BG[key] ? bgOf(BG[key]!) : "\x1b[49m"),
		getColorMode: () => mode,
		fg: (key, text) => (FG[key] ? `${fgOf(FG[key]!)}${text}\x1b[39m` : text),
		bg: (key, text) => (BG[key] ? `${bgOf(BG[key]!)}${text}\x1b[49m` : text),
		bold: (text) => `\x1b[1m${text}\x1b[22m`,
	};
}
