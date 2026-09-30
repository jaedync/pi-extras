/** Shared, still handoff chip. Only the words are tinted; live work belongs in the widget. */
import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { paintLine, type Outcome, type Seg } from "./band.ts";
import { mix, type Rgb } from "./color.ts";
import { paletteFrom, type BandTheme, type Palette } from "./palette.ts";

export const CHIP_INDENT = 2;
export type ChipTint = "running" | Outcome | "unknown" | "writing";
const CHIP_TINT: Record<ChipTint, [keyof Palette, number]> = {
	running: ["accent", 0.16], ok: ["success", 0.22], fail: ["error", 0.26],
	timeout: ["warning", 0.22], aborted: ["muted", 0.12], unknown: ["muted", 0.08], writing: ["muted", 0.04],
};
const segsWidth = (segs: readonly Seg[]) => segs.reduce((sum, seg) => sum + visibleWidth(seg.text), 0);

function cutSegs(segs: readonly Seg[], room: number): Seg[] {
	const out: Seg[] = [];
	let left = room;
	for (const seg of segs) {
		const width = visibleWidth(seg.text);
		if (width <= left) { out.push(seg); left -= width; continue; }
		if (left > 0) out.push({ ...seg, text: stripTerminalSequences(truncateToWidth(seg.text, left, "…")) });
		break;
	}
	return out;
}

export interface ChipOptions {
	readonly width: number;
	readonly title: readonly Seg[];
	readonly status: readonly Seg[];
	readonly tint: ChipTint;
	readonly glyphColor: string;
}

export function handoffChip(theme: BandTheme, options: ChipOptions): string {
	const glyph: Seg = { text: "↳ ", color: options.glyphColor, bold: true };
	const gap: Seg[] = options.status.length > 0 ? [{ text: "  ", color: "dim" }] : [];
	const room = Math.max(0, options.width - CHIP_INDENT - 1);
	const fixed = 1 + visibleWidth(glyph.text) + segsWidth(gap) + segsWidth(options.status) + 1;
	const title = cutSegs(options.title, Math.max(1, room - fixed));
	const segs = cutSegs([{ text: " ", color: "text" }, glyph, ...title, ...gap, ...options.status, { text: " ", color: "text" }], room);
	const end = CHIP_INDENT + segsWidth(segs);
	const palette = paletteFrom(theme);
	const [hue, amount] = CHIP_TINT[options.tint];
	const tint: Rgb | undefined = palette ? mix(palette.base, palette[hue] as Rgb, amount) : undefined;
	return paintLine(theme, palette, {
		width: options.width, left: segs, indent: CHIP_INDENT,
		...(tint ? { bgAt: (x: number) => (x >= CHIP_INDENT && x < end ? tint : undefined) } : {}),
	});
}
