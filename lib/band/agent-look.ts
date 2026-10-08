/**
 * How a subagent looks wherever it shows: like someone talking in a
 * conversation, with no band behind it. A ◆ and its name in its provider's
 * color, the one the footer gives that provider, so whose model an agent runs
 * on reads before its model does: the shared olive for a provider the footer
 * has no color of its own for, and Pi's custom-message purple when the model
 * names no provider. Then what it is doing and the facts about it, close together on
 * one line, and what it says set in under its name. Shell jobs are bands
 * that fill with their progress
 * (job-look.ts), so the two never read alike at a glance.
 *
 * What an agent is doing moves the way main's own spinner does for the same
 * work, so thinking, writing, a tool call or a compaction look alike on every
 * agent and on main.
 */
import type { MarkdownTheme } from "@earendil-works/pi-tui";
import { paintLine, ROW_MARGIN, type Motion, type Seg } from "./band.ts";
import { FAILURE_GLYPH, MODE_SPINNERS, SPINNER_SLOT_WIDTH, STOPPED_GLYPH, SUCCESS_GLYPH, slotGlyph, type GlyphAnimation } from "./glyph.ts";
import { providerColor } from "../status-plus-render.ts";
import { messageBody } from "./message.ts";
import { paletteFrom, type BandTheme } from "./palette.ts";
import { mix, parseAnsiColor, type Rgb } from "./color.ts";

export const AVATAR = "◆";
/** An agent that hasn't begun: queued, or its call still being written. */
export const AVATAR_HOLLOW = "◇";
/** The theme key an agent is drawn in when its model names no provider. */
export const AGENT_HUE = "customMessageLabel";

/** An agent's color from its `provider/model` ref, as a segment color. */
export function agentHue(model: string | undefined): string {
	const slash = model?.indexOf("/") ?? -1;
	const rgb = slash > 0 ? providerColor(model!.slice(0, slash)) : undefined;
	return rgb ? `#${rgb.map((value) => value.toString(16).padStart(2, "0")).join("")}` : AGENT_HUE;
}
// Themes don't name the terminal's own background. A tool row's gray is a step
// up from it on a dark theme and a step down on a light one, so step back.
const PAGE_STEP = 0.25;
// How much of the agent's color washes over that, enough to tell its chat from main's.
const GROUND_TINT = 0.11;
const BLACK: Rgb = [0, 0, 0];
const WHITE: Rgb = [255, 255, 255];
const luminance = ([r, g, b]: Rgb): number => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

/** An agent's color as RGB, from a `#rrggbb` hue or a theme key. */
function hueRgb(theme: BandTheme, hue: string): Rgb | undefined {
	const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hue);
	if (hex) return [parseInt(hex[1]!, 16), parseInt(hex[2]!, 16), parseInt(hex[3]!, 16)];
	try { return parseAnsiColor(theme.getFgAnsi(hue)); } catch { return undefined; }
}

/**
 * What an agent's own chat sits on: about the terminal's background, washed
 * with the agent's color, so its chat never reads as main's. Undefined when
 * the theme's colors can't be read back.
 */
export function agentGround(theme: BandTheme, model: string | undefined): Rgb | undefined {
	const palette = paletteFrom(theme);
	const tint = hueRgb(theme, agentHue(model));
	if (!palette || !tint) return undefined;
	const page = mix(palette.base, luminance(palette.base) < 0.5 ? BLACK : WHITE, PAGE_STEP);
	return mix(page, tint, GROUND_TINT);
}

/** Between an agent's name, what it is doing and the facts about it. */
export const GAP: Seg = { text: "  ", color: "dim" };

export type Doing = "queued" | "starting" | "thinking" | "writing" | "tool" | "compacting" | "asking" | "waiting" | "done";

/**
 * One line of an agent, on the terminal's own background. It starts after
 * the margin transcript rows keep, so the ◆ lines up with a tool row's title;
 * whatever runs past the width is cut from the end.
 */
export function agentLine(theme: BandTheme, segs: readonly Seg[], width: number): string {
	return paintLine(theme, paletteFrom(theme), { width, left: [{ text: " ".repeat(ROW_MARGIN), color: "" }, ...segs], indent: 0 });
}

/** Groups of segments with a gap between each, skipping empty ones. */
export const spaced = (...groups: ReadonlyArray<readonly Seg[]>): Seg[] =>
	groups.filter((group) => group.length > 0).flatMap((group, index) => (index === 0 ? [...group] : [GAP, ...group]));

/** `◆`, or hollow `◇` while an agent waits its turn. */
export const avatarOf = (record: { readonly state: string }): string => (record.state === "queued" ? AVATAR_HOLLOW : AVATAR);

/** What an agent is doing, from its state and the activity words its session reports. */
export function doingOf(record: { readonly state: string; readonly activity: string | null }): Doing {
	switch (record.state) {
		case "queued": return "queued";
		case "starting": return "starting";
		case "asking": return "asking";
		case "waiting": return "waiting";
		case "running": break;
		default: return "done";
	}
	switch (record.activity) {
		case null: case "thinking": return "thinking";
		case "writing": return "writing";
		case "compacting context": return "compacting";
		case "starting": return "starting";
		default: return "tool";
	}
}

/** `null` is the agent's own color: work that is the agent itself rather than a tool or a wait. */
const MOTION: Record<Doing, { readonly animation?: GlyphAnimation; readonly color: string | null; readonly still?: string }> = {
	thinking: { animation: MODE_SPINNERS.think, color: null },
	writing: { animation: MODE_SPINNERS.text, color: null },
	tool: { animation: MODE_SPINNERS.tool, color: "accent" },
	compacting: { animation: MODE_SPINNERS.compaction, color: null },
	starting: { animation: MODE_SPINNERS.prep, color: "muted" },
	asking: { animation: MODE_SPINNERS.peer, color: "warning" },
	waiting: { animation: MODE_SPINNERS.peer, color: "muted" },
	queued: { color: "dim", still: "·" },
	done: { color: "dim", still: " " },
};

/**
 * The glyph for what an agent is doing, always SPINNER_SLOT_WIDTH cells wide so
 * the words after it hold still. Tool work takes the tool color, as tool rows do.
 */
export function doingGlyph(doing: Doing, ms: number, motion: Motion = "full", hue = AGENT_HUE): { glyph: string; color: string } {
	const look = MOTION[doing];
	const color = look.color ?? hue;
	if (!look.animation) return { glyph: inSlot(look.still ?? " "), color };
	return { glyph: slotGlyph(look.animation, ms, { reduced: motion === "reduced", rateElapsedMs: ms }), color };
}

/** One still glyph centred in the slot spinners take. */
const inSlot = (glyph: string): string => {
	const pad = SPINNER_SLOT_WIDTH - 1;
	return `${" ".repeat(Math.floor(pad / 2))}${glyph}${" ".repeat(Math.ceil(pad / 2))}`;
};

const ENDED: Readonly<Record<string, { readonly glyph: string; readonly color: string }>> = {
	idle: { glyph: SUCCESS_GLYPH, color: "success" },
	failed: { glyph: FAILURE_GLYPH, color: "error" },
	stopped: { glyph: STOPPED_GLYPH, color: "muted" },
	interrupted: { glyph: "!", color: "warning" },
};

/** How a run ended, in the glyph slot (` ✓ `, ` ✗ `, ` ■ `, ` ! `), so an ended row has no hole; none while it runs. */
export function endGlyph(state: string): { glyph: string; color: string } | undefined {
	const ended = ENDED[state];
	return ended ? { glyph: inSlot(ended.glyph), color: ended.color } : undefined;
}

/**
 * What an agent said, under its header: Markdown or plain text set in under
 * its name, on no background. `limit` is a preview's line count, `null` all of it.
 */
export function agentBody(theme: BandTheme, width: number, text: string, color: string, limit: number | null, markdown?: MarkdownTheme): string[] {
	return messageBody(theme, width, text, color, limit, markdown, null);
}
