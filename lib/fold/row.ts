/**
 * A fold group's line and the end of its rule: what the line says, its
 * spinner while live, and the click that opens or closes the group (see
 * transcript.ts, which places them).
 */
import { stripTerminalSequences, truncateToWidth, visibleWidth, type Color, type Component, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { ROW_MARGIN } from "../band/band.ts";
import { BULLET_GLYPH, MODE_SPINNERS, slotGlyph, THOUGHT_GLYPH, type GlyphAnimation } from "../band/glyph.ts";
import { shimmerWords } from "./shimmer.ts";
import { foldPhrase, foldStats, thoughtOnly, type FoldFacts, type FoldPhase } from "./summary.ts";

export interface FoldTheme {
	fg(key: string, text: string): string;
	italic?(text: string): string;
	/** The theme's colors and a painter for any color: a live line's words shimmer with them. */
	readonly colors?: Readonly<Record<string, Color | undefined>>;
	style?(text: string, options: { fg?: Color }): string;
}

/** What a line needs from its host. */
export interface FoldRowHost {
	theme(): FoldTheme | undefined;
	now(): number;
	reduced(): boolean;
	redraw(): void;
}

/** Columns the words keep before the figures give way. */
const MIN_WORDS = 16;

interface Segment {
	readonly key: string;
	readonly text: string;
}

/** Segments cut to `room` columns, ending `…` without a dangling comma or space when cut. */
export function cut(segments: readonly Segment[], room: number): Segment[] {
	const plain = segments.map((segment) => segment.text).join("");
	if (visibleWidth(plain) <= room) return [...segments];
	const out: Segment[] = [];
	let left = Math.max(0, room - 1);
	for (const segment of segments) {
		if (left <= 0) break;
		// Pi's cut adds a color reset; the segments are plain text and get their color after.
		const text = stripTerminalSequences(truncateToWidth(segment.text, left, ""));
		out.push({ key: segment.key, text });
		left -= visibleWidth(text);
	}
	while (out.length > 0) {
		const last = out.at(-1)!;
		const trimmed = last.text.replace(/[\s,]+$/u, "");
		if (trimmed) {
			out[out.length - 1] = { key: last.key, text: `${trimmed}…` };
			return out;
		}
		out.pop();
	}
	return [{ key: segments[0]?.key ?? "text", text: "…" }];
}

/** Where a group's line sits and how it reads. */
export interface FoldLook {
	/** Under the reply that made the calls: set in by the reply's margin, with no blank line above. */
	readonly hung: boolean;
	/** Its rows show. */
	readonly open: boolean;
}

const RULE = "│";
const RULE_END = "╰─ ";
const CLOSE = "close";
/** Columns the rule takes: its glyph and a space. */
export const RULE_WIDTH = 2;

/** What a line holds that a terminal draws as an image; a rule in front would move it. */
export const isImage = (line: string) => line.includes("\x1b_G") || line.includes("\x1b]1337;File=");

export const paintWith = (theme: FoldTheme | undefined) => (key: string, text: string) => {
	try { return theme ? theme.fg(key, text) : text; } catch { return text; }
};

/** One group's line: a blank line above, as Pi's rows have, then the summary; a hung line has no blank line. */
export class FoldRow implements Component {
	open = false;
	private facts: FoldFacts = { tools: [], live: false, tokens: 0 };
	private look: FoldLook = { hung: false, open: false };
	private drawing?: { key: string; facts: FoldFacts; theme: FoldTheme | undefined; lines: string[] };
	private readonly host: FoldRowHost;
	/** The rule's end under an open group; a click on it closes the group. */
	readonly end: Component;

	constructor(host: FoldRowHost) {
		this.host = host;
		this.end = new FoldEnd(this);
	}

	update(facts: FoldFacts, look: FoldLook = this.look): void {
		this.facts = facts;
		this.look = look;
	}

	/** Opens or closes the group. */
	toggle(): void {
		this.open = !this.open;
		this.host.redraw();
	}

	private indent(): string {
		return this.look.hung ? " ".repeat(ROW_MARGIN) : "";
	}

	/** Columns in front of an open group's rows. */
	ruleWidth(): number {
		return this.indent().length + RULE_WIDTH;
	}

	/** What goes in front of each of an open group's rows. */
	rule(): string {
		return `${this.indent()}${paintWith(this.host.theme())("borderMuted", RULE)} `;
	}

	endLine(width: number): string {
		const paint = paintWith(this.host.theme());
		return truncateToWidth(`${this.indent()}${paint("borderMuted", RULE_END)}${paint("dim", CLOSE)}`, width, "");
	}

	/** Kept while the facts (the same object while a group is settled), width, glyph, look and theme are unchanged. */
	render(width: number): string[] {
		const theme = this.host.theme();
		const { live } = this.facts;
		const now = this.host.now();
		const glyph = live ? slotGlyph(SPINNERS[this.facts.phase ?? "wait"], now, { reduced: this.host.reduced() }) : BULLET_GLYPH;
		const key = `${width}|${glyph}|${this.look.hung}|${this.look.open}|${live && !this.host.reduced() ? now : ""}`;
		const kept = this.drawing;
		if (kept?.key === key && kept.facts === this.facts && kept.theme === theme) return kept.lines;
		const lines = this.draw(width, glyph, theme);
		this.drawing = { key, facts: this.facts, theme, lines };
		return lines;
	}

	/**
	 * One block on the left: the bullet, the words, a comma, then the figures
	 * with spaces between them (`↑681k ↓6.9k 2m21s`). Words too long for the
	 * line become the total count of calls; on a narrower line they are cut,
	 * and the figures go only when even short words wouldn't fit beside them.
	 * While live, the phase spinner's own spinner for what the model does now
	 * takes the bullet's place and the margin before it, so a hung line's
	 * words stay where they settle.
	 */
	private draw(width: number, glyph: string, theme: FoldTheme | undefined): string[] {
		const paint = paintWith(theme);
		const { live } = this.facts;
		const { hung, open } = this.look;
		const indent = this.indent();
		const placed = (line: string) => {
			const fitted = truncateToWidth(line, width, "");
			return hung ? [fitted] : ["", fitted];
		};
		if (thoughtOnly(this.facts)) {
			// Drawn as Tool Display draws a finished thinking block, so the two views agree.
			const label = paint(open ? "muted" : "dim", truncateToWidth(`${THOUGHT_GLYPH} ${foldPhrase(this.facts).said}`, Math.max(1, width - indent.length), "…"));
			let italic = label;
			try { italic = theme?.italic?.(label) ?? label; } catch { /* Plain is fine. */ }
			return placed(indent + italic);
		}
		const stats = foldStats(this.facts).join(" ");
		const tail = stats ? `, ${stats}` : "";
		const lead = live ? "" : indent;
		// The glyph, a space, and a column to spare.
		const before = lead.length + visibleWidth(glyph) + 2;
		const room = width - before - visibleWidth(tail);
		const fits = room >= MIN_WORDS;
		const space = Math.max(1, fits ? room : width - before);
		// A live line rests on the settled gray and shimmers; an open one is brighter.
		const tone = open && !live ? "text" : "muted";
		const segments = (brief: boolean): Segment[] => {
			const phrase = foldPhrase(this.facts, brief);
			return [
				{ key: tone, text: phrase.said },
				...(phrase.failed ? [{ key: tone, text: ", " }, { key: "error", text: phrase.failed }] : []),
			];
		};
		const full = segments(false);
		const words = visibleWidth(full.map((segment) => segment.text).join("")) <= space ? full : segments(true);
		const shown = cut(words, space);
		const left = (live && theme ? this.shimmer(shown, tone, theme) : undefined) ?? shown.map((segment) => paint(segment.key, segment.text)).join("");
		return placed(`${lead}${paint(live ? "accent" : open ? "muted" : "dim", glyph)} ${left}${fits ? paint("dim", tail) : ""}`);
	}

	private shimmer(segments: readonly Segment[], tone: string, theme: FoldTheme): string | undefined {
		if (this.host.reduced()) return undefined;
		try { return shimmerWords(segments, tone, this.host.now(), theme); } catch { return undefined; }
	}

	invalidate(): void {
		this.drawing = undefined;
	}

	/** A click on the summary line, not the blank line above it, opens or closes the group. */
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "click" || event.button !== "left" || event.y !== (this.look.hung ? 0 : 1)) return undefined;
		this.toggle();
		return { handled: true };
	}
}

/** The end of an open group's rule: `╰─ close`. */
class FoldEnd implements Component {
	private readonly row: FoldRow;

	constructor(row: FoldRow) {
		this.row = row;
	}

	render(width: number): string[] {
		return [this.row.endLine(width)];
	}

	invalidate(): void {}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "click" || event.button !== "left") return undefined;
		this.row.toggle();
		return { handled: true };
	}
}

/** The phase spinner's spinner for each, 3 cells wide (SPINNER_SLOT_WIDTH): its sonar for every wait before the first token. */
const SPINNERS: Readonly<Record<FoldPhase, GlyphAnimation>> = {
	wait: MODE_SPINNERS.first_token, think: MODE_SPINNERS.think, tool: MODE_SPINNERS.tool, run: MODE_SPINNERS.run, peer: MODE_SPINNERS.peer,
};
