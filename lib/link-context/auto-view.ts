/**
 * How auto-pull looks in the transcript, in the same parts as the other rows.
 *
 * The message: a band that says how many links of the user's message were
 * read, with its status where a tool row has it: the dot and the band in the
 * outcome's color (green when any link was read), the failures and the time
 * on the right. Under it, one gutter line per link: the platform (or host),
 * the title and what came with it. Three show while collapsed; a click or
 * ctrl+o shows all, each with its address and summary.
 *
 * The wait: while the links are read, a widget above the editor shows the
 * same band running, with each link named in the color of its state and the
 * time against the wait's limit.
 */
import type { MessageRenderer } from "@earendil-works/pi-coding-agent";
import { keyHint } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { SEP } from "../cc-phase.ts";
import { everyFrame, FRAME_MS, REDUCED_FRAME_MS } from "../band/clock.ts";
import { renderBand, ROW_MARGIN, type BandPhase, type Motion, type Outcome, type Seg } from "../band/band.ts";
import { GUTTER } from "../band/job-look.ts";
import { expandable, expansionMemory } from "../band/message.ts";
import { paletteFrom, type BandTheme } from "../band/palette.ts";
import { link } from "../kagi/render.ts";
import { rail } from "../tool-display/row.ts";
import type { AutoDetails, LinkFacts, LinkState } from "./auto-message.ts";
import { LINK_CHARS, MAX_LINKS } from "./auto-message.ts";
import { clean, kChars, previewFact, TOOL_NAME } from "./format.ts";
import { hostOf, platformName, reason } from "./names.ts";

/** Links listed under the band while collapsed. */
export const LINK_PREVIEW = 3;
/** The platform column is no wider than this. */
const KEY_CHARS = 18;

export interface WaitLink {
	readonly url: string;
	readonly state: LinkState;
	readonly platform?: string;
}

/** What the wait widget reads at each frame: the links as they are now, and when the wait started. */
export interface WaitState {
	readonly links: () => readonly WaitLink[];
	readonly startedAt: number;
	readonly limitMs: number;
}

const isRead = (state: LinkState) => state === "read" || state === "cached";
const plural = (count: number, word: string) => `${count.toLocaleString("en-US")} ${word}${count === 1 ? "" : "s"}`;

function paint(theme: BandTheme, key: string, text: string): string {
	try { return theme.fg(key, text); } catch { return text; }
}

function expandHint(): string {
	try { return keyHint("app.tools.expand", "to expand"); } catch { return "ctrl+o to expand"; }
}

/** The links of saved details, each with a URL and a known state; anything else is dropped. */
function linksOf(details: unknown): { links: LinkFacts[]; more: number; durationMs?: number } | undefined {
	const known = details && typeof details === "object" ? (details as Partial<AutoDetails>) : undefined;
	if (!known || !Array.isArray(known.links)) return undefined;
	const states: readonly LinkState[] = ["read", "cached", "failed", "reading", "skipped"];
	const links = known.links.filter((item): item is LinkFacts => !!item && typeof item.url === "string" && states.includes(item.state));
	if (!links.length) return undefined;
	const more = typeof known.more === "number" && known.more > 0 ? known.more : 0;
	return { links, more, ...(typeof known.durationMs === "number" ? { durationMs: known.durationMs } : {}) };
}

/** Green when any link was read, red when every read failed, a warning when the rest are late or past the limit. */
function outcomeOf(links: readonly LinkFacts[]): Outcome {
	if (links.some((item) => isRead(item.state))) return "ok";
	return links.some((item) => item.state === "failed") ? "fail" : "timeout";
}

function statusSegs(links: readonly LinkFacts[], more: number): Seg[] {
	const count = (state: LinkState) => links.filter((item) => item.state === state).length;
	const parts: Seg[] = [];
	if (count("failed")) parts.push({ text: `${count("failed")} failed`, color: "error" });
	if (count("reading")) parts.push({ text: `${count("reading")} still reading`, color: "warning" });
	if (count("skipped") + more) parts.push({ text: `${count("skipped") + more} not read`, color: "muted" });
	return parts.flatMap((part, index) => (index === 0 ? [part] : [{ text: SEP, color: "muted" }, part]));
}

function head(theme: BandTheme, width: number, links: readonly LinkFacts[], more: number, durationMs: number | undefined): string {
	const read = links.filter((item) => isRead(item.state)).length;
	const all = links.length + more;
	const what = read === all ? plural(all, "link") : `${read} of ${plural(all, "link")}`;
	const phase: BandPhase = { kind: "done", outcome: outcomeOf(links), sinceMs: Number.POSITIVE_INFINITY };
	const status = statusSegs(links, more);
	const segs: Seg[] = [{ text: TOOL_NAME, color: "accent", bold: true }, { text: ` ${what} from your message`, color: "text" }];
	return renderBand(theme, paletteFrom(theme), { width, phase, segs, rail: rail(phase, durationMs, { lead: status, failure: status }), clockMs: 0, margin: true });
}

const keyOf = (item: LinkFacts) => clean(isRead(item.state) ? platformName(item.platform, item.url) : hostOf(item.url), KEY_CHARS);

/** A saved result came as a preview of the whole text; any other long one as its first page. Details come from the session file, so the path's type is checked. */
function sizeFact(item: LinkFacts): string {
	if (!item.truncated || !item.chars) return "";
	return typeof item.saved === "string" && item.saved ? previewFact(item.chars) : `first ${kChars(LINK_CHARS)} of ${kChars(item.chars)} chars`;
}

function linkLine(theme: BandTheme, item: LinkFacts, keyWidth: number): string {
	const key = paint(theme, "muted", truncateToWidth(keyOf(item), keyWidth, "…").padEnd(keyWidth));
	switch (item.state) {
		case "failed": return `${key}  ${paint(theme, "error", `failed: ${clean(reason(item.error ?? "", item.url))}`)}`;
		case "reading": return `${key}  ${paint(theme, "dim", `still reading; ${TOOL_NAME} uses its result when it is ready`)}`;
		case "skipped": return `${key}  ${paint(theme, "dim", `not read: only the first ${MAX_LINKS} links are read`)}`;
		default: {
			const facts = [
				item.images ? plural(item.images, "image") : "",
				sizeFact(item),
				item.state === "cached" ? "cached" : "",
			].filter(Boolean).join(SEP);
			return `${key}  ${paint(theme, "toolOutput", clean(item.title || item.url))}${facts ? `  ${paint(theme, "dim", facts)}` : ""}`;
		}
	}
}

/** The address and summary under a link, lined up with its title. */
function moreLines(theme: BandTheme, item: LinkFacts, pad: string): string[] {
	const preview = Array.isArray(item.preview) ? item.preview.filter((line): line is string => typeof line === "string") : [];
	return [`${pad}${link(paint(theme, "dim", clean(item.url, 300)), item.url)}`, ...preview.map((line) => `${pad}${paint(theme, "muted", clean(line, 300))}`)];
}

function gutter(theme: BandTheme, lines: readonly string[], width: number): string[] {
	const room = Math.max(1, width - ROW_MARGIN - 2);
	return lines.map((line) => truncateToWidth(`${" ".repeat(ROW_MARGIN)}${paint(theme, "border", GUTTER)} ${truncateToWidth(line, room, "…")}`, Math.max(1, width), "…"));
}

/** The message's lines: the band, then a gutter line per link; `expanded` lists all, each with its address and summary. */
export function autoLines(theme: BandTheme, width: number, details: unknown, expanded: boolean, hint = `click or ${expandHint()}`): string[] {
	const found = linksOf(details);
	if (!found) return [];
	const { links, more, durationMs } = found;
	const keyWidth = Math.max(...links.map((item) => visibleWidth(keyOf(item))));
	const pad = " ".repeat(keyWidth + 2);
	// One link more shows in the line a hint for it would take.
	const shown = expanded || links.length + more <= LINK_PREVIEW + 1 ? links : links.slice(0, LINK_PREVIEW);
	const body = shown.flatMap((item) => [linkLine(theme, item, keyWidth), ...(expanded ? moreLines(theme, item, pad) : [])]);
	const hidden = links.length - shown.length + more;
	if (!expanded && hidden > 0) body.push(`${paint(theme, "muted", `… ${plural(hidden, "more link")} (`)}${paint(theme, "dim", hint)}${paint(theme, "muted", ")")}`);
	if (expanded && more > 0) body.push(paint(theme, "muted", `… and ${plural(more, "more link")}, not read`));
	return [head(theme, width, links, more, durationMs), ...gutter(theme, body, width)];
}

/** The `pull-link-auto` message renderer: the lines above, expanded by a click or ctrl+o. */
export function createAutoRenderer(): MessageRenderer {
	const memory = expansionMemory();
	return (message, options, theme) => {
		if (!linksOf(message.details)) return undefined;
		return expandable((width, expanded) => autoLines(theme, width, message.details, expanded), options.expanded, message as object, memory);
	};
}

/** The wait's band: running, each link in the color of its state, the time against the limit. */
export function waitLine(theme: BandTheme, width: number, links: readonly WaitLink[], elapsedMs: number, limitMs: number, clockMs: number, motion: Motion): string {
	const phase: BandPhase = { kind: "running", elapsedMs, timeoutMs: limitMs };
	const names = links.flatMap((item, index): Seg[] => {
		const name = clean(isRead(item.state) ? platformName(item.platform, item.url) : hostOf(item.url), KEY_CHARS);
		const seg: Seg = item.state === "failed" ? { text: `${name} failed`, color: "error" } : isRead(item.state) ? { text: name, color: "text" } : { text: name, color: "dim" };
		return index === 0 ? [seg] : [{ text: SEP, color: "muted" }, seg];
	});
	const segs: Seg[] = [{ text: TOOL_NAME, color: "accent", bold: true }, { text: " ", color: "text" }, ...names];
	return renderBand(theme, paletteFrom(theme), { width, phase, segs, rail: rail(phase, undefined), clockMs, motion, margin: true, toolName: TOOL_NAME });
}

/** The widget factory for the wait: one band line, redrawn on the shared frame clock until Pi disposes it. */
export function waitWidget(state: WaitState, motion: () => Motion, now: () => number = Date.now) {
	return (tui: { requestRender(): void }, theme: BandTheme) => {
		const stop = everyFrame(() => tui.requestRender(), motion() === "reduced" ? REDUCED_FRAME_MS : FRAME_MS);
		return {
			render: (width: number) => {
				const at = now();
				return [waitLine(theme, width, state.links(), Math.max(0, at - state.startedAt), state.limitMs, at, motion())];
			},
			invalidate() {},
			dispose: stop,
		};
	};
}
