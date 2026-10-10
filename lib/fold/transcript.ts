/**
 * Fold mode: the transcript shows each run of work between replies as one
 * line (see plan.ts and summary.ts). A run of calls hangs under the reply
 * that made them; a reply's thinking alone sits right above its words. A
 * click on the line, or Pi's expand key (ctrl+o), opens the group: its rows
 * show in a rule under the line, and the rule's end closes it again.
 *
 * Pi has no hook for the transcript as a whole, so this wraps the render of
 * Pi's chat container, the third child of the document Pi mounts first. Every
 * row still renders on every frame, folded or not, because tool rows keep
 * their timing and animation state in their own render; a folded row's lines
 * are dropped. The container's mouse layout is written to match the lines,
 * so clicks land on the rows drawn. Any other layout is left alone.
 */
import { Spacer, stripTerminalSequences, Text, truncateToWidth, visibleWidth, type Color, type Component, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { ROW_MARGIN } from "../band/band.ts";
import { BULLET_GLYPH, isBlockingPeer, MODE_SPINNERS, slotGlyph, THOUGHT_GLYPH, type GlyphAnimation } from "../band/glyph.ts";
import { planFold, type FoldGroup, type FoldPlan, type PlanEntry, type PlanItem } from "./plan.ts";
import { shimmerWords } from "./shimmer.ts";
import { foldPhrase, foldStats, thoughtOnly, type FoldFacts, type FoldPhase, type ToolFact } from "./summary.ts";
import { CHARS_PER_TOKEN } from "../cc-phase.ts";
import { commandsIn, isShell } from "../tool-count.ts";
import { cleanLabel, fileOf } from "../tool-phrase.ts";

export { commandsIn };

export interface FoldTheme {
	fg(key: string, text: string): string;
	italic?(text: string): string;
	/** The theme's colors and a painter for any color: a live line's words shimmer with them. */
	readonly colors?: Readonly<Record<string, Color | undefined>>;
	style?(text: string, options: { fg?: Color }): string;
}

export interface ReplyMessage {
	readonly content: readonly { readonly type: string; readonly text?: unknown; readonly thinking?: unknown; readonly arguments?: unknown }[];
	readonly usage?: { readonly input?: number; readonly output?: number; readonly cacheRead?: number; readonly cacheWrite?: number };
	readonly timestamp?: number;
	readonly stopReason?: string;
	readonly provider?: string;
	readonly model?: string;
}

/** A call made inside another call, as Tool Display keeps it: `args` is the arguments as JSON text. */
export interface NestedFact {
	readonly name: string;
	readonly status: string;
	readonly args?: string;
}

export interface FoldHost {
	enabled(): boolean;
	theme(): FoldTheme | undefined;
	/** An agent run is going. */
	busy(): boolean;
	now(): number;
	reduced(): boolean;
	/** When a call's result arrived, if known. */
	toolEndedAt(toolCallId: string): number | undefined;
	/** How long a reply thought, if known; `live`: with a run still going, its time so far. */
	thoughtMs(message: ReplyMessage, live?: boolean): number | undefined;
	/** The calls a script (codemode) made inside a call, if any are known. */
	nestedOf(toolCallId: string): readonly NestedFact[] | undefined;
	/** The model has written this call, though Pi completes its arguments only when the reply ends. */
	written?(toolCallId: string): boolean;
	/** Frames are wanted while a line is live, and not after. */
	animate(live: boolean): void;
	redraw(): void;
}

export interface Box {
	children: Component[];
	mouseLayout?: { width: number; children: Array<{ component: Component; height: number }> };
	render(width: number): string[];
}

/** The parts of Pi's tool row this reads. */
interface ToolRow extends Component {
	readonly toolName: string;
	readonly toolCallId: string;
	readonly isPartial: boolean;
	readonly args?: unknown;
	/** Pi's own flags; absent in an older Pi, where a call never reads as written. */
	readonly argsComplete?: boolean;
	readonly executionStarted?: boolean;
	readonly expanded?: boolean;
	readonly result?: { readonly isError?: boolean };
}

/** The parts of Pi's assistant message this reads. */
interface Reply extends Component {
	readonly lastMessage?: ReplyMessage;
	readonly isStreaming: boolean;
	readonly contentContainer: unknown;
}

const isBox = (value: unknown): value is Box =>
	!!value && typeof value === "object" && Array.isArray((value as Box).children) && typeof (value as Box).render === "function";

export const isToolRow = (child: unknown): child is ToolRow =>
	!!child && typeof child === "object" && typeof (child as ToolRow).toolCallId === "string"
	&& typeof (child as ToolRow).toolName === "string" && typeof (child as ToolRow).isPartial === "boolean";

export const isReply = (child: unknown): child is Reply =>
	!!child && typeof child === "object" && "lastMessage" in child && "contentContainer" in child && typeof (child as Reply).isStreaming === "boolean";

/** Pi's layout: seven containers, the document first; the chat is the document's third child. */
const LAYOUT_SIZE = 7;
const DOCUMENT_SIZE = 3;
const CHAT_AT = 2;

/** Pi's chat container, when `tui` holds Pi's layout. */
export function findTranscript(tui: unknown): Box | undefined {
	const children = (tui as { children?: unknown } | undefined)?.children;
	if (!Array.isArray(children) || children.length !== LAYOUT_SIZE) return undefined;
	const document = children[0];
	if (!isBox(document) || document.children.length !== DOCUMENT_SIZE || !document.children.every(isBox)) return undefined;
	return document.children[CHAT_AT] as unknown as Box;
}

/** Whether a reply thought (and so has thinking to fold). */
export function thought(message: ReplyMessage | undefined): boolean {
	return !!message?.content.some((part) => part.type === "thinking" && typeof part.thinking === "string" && part.thinking.trim() !== "");
}

/** Whether a reply shows anything but thinking: text, or a notice Pi adds for how it ended. */
export function speaks(message: ReplyMessage | undefined): boolean {
	if (!message) return false;
	if (message.content.some((part) => part.type === "text" && typeof part.text === "string" && part.text.trim() !== "")) return true;
	const calls = message.content.some((part) => part.type === "toolCall");
	return message.stopReason === "length" || (!calls && (message.stopReason === "aborted" || message.stopReason === "error"));
}

function kindOf(child: Component): PlanItem["kind"] {
	if (isToolRow(child)) return "tool";
	if (isReply(child)) {
		const message = child.lastMessage;
		return !speaks(message) ? "work" : thought(message) ? "said" : "visible";
	}
	if (child instanceof Spacer) return "spacer";
	// Pi's status lines and notices (ThemedText extends Text) arrive mid-run and must not split a group.
	if (child instanceof Text) return "note";
	return "visible";
}

/** Kinds whose rows join a group; they are drawn once the plan says how wide. */
const FOLDING = new Set<PlanItem["kind"]>(["tool", "work", "said"]);

/** Input tokens a reply sent: fresh input and cache reads and writes. */
export function sentOf(message: ReplyMessage): number {
	const usage = message.usage;
	const sum = (usage?.input ?? 0) + (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0);
	return Number.isFinite(sum) && sum > 0 ? sum : 0;
}

/** The longest name a failed call gets on the line. */
const LABEL_MAX = 32;

/** A call's arguments as an object: a nested call's come as JSON text. */
function argsOf(args: unknown): unknown {
	if (typeof args !== "string") return args;
	try { return JSON.parse(args) as unknown; } catch { return undefined; }
}

/** What a call ran, short enough for the line (`ls node_modules`, `read b.ts`); undefined for a shell call without its command. */
export function callLabel(name: string, args: unknown): string | undefined {
	const given = argsOf(args) as { command?: unknown } | null | undefined;
	const tool = cleanLabel(name).split(/__|\./).at(-1) ?? "";
	const file = fileOf(given);
	const text = isShell(name) ? (typeof given?.command === "string" ? cleanLabel(given.command) : "") : file ? `${tool} ${file}` : tool;
	if (!text) return undefined;
	return text.length > LABEL_MAX ? `${text.slice(0, LABEL_MAX - 1)}…` : text;
}

/** The file a call works on, and what it ran when it failed. */
function namesOf(name: string, args: unknown, failed: boolean): Pick<ToolFact, "file" | "label"> {
	const file = fileOf(argsOf(args));
	const label = failed ? callLabel(name, args) : undefined;
	return { ...(file ? { file } : {}), ...(label ? { label } : {}) };
}

/** One call as the words count it: a script's own calls in its place, and a chain's steps. */
export function factsOfCall(name: string, args: unknown, failed: boolean, nested: readonly NestedFact[] | undefined): ToolFact[] {
	if (nested && nested.length > 0) {
		const inner = nested.map((call): ToolFact => ({
			name: call.name,
			failed: call.status === "error",
			count: isShell(call.name) ? commandsIn(call.args) : 1,
			...namesOf(call.name, call.args, call.status === "error"),
		}));
		// The script is counted through its calls; it still says when it fails itself.
		return failed ? [...inner, { name, failed, count: 0 }] : inner;
	}
	return [{ name, failed, ...(isShell(name) ? { count: commandsIn(args) } : {}), ...namesOf(name, args, failed) }];
}

/** Output tokens: the reported count, or an estimate from the characters while it streams. */
export function tokensOf(message: ReplyMessage, streaming: boolean): number {
	const reported = message.usage?.output ?? 0;
	if (!streaming && reported > 0) return reported;
	let chars = 0;
	for (const part of message.content) {
		if (typeof part.text === "string") chars += part.text.length;
		if (typeof part.thinking === "string") chars += part.thinking.length;
		if (part.type === "toolCall" && part.arguments !== undefined) chars += JSON.stringify(part.arguments)?.length ?? 0;
	}
	return Math.max(reported, chars / CHARS_PER_TOKEN);
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
const RULE_WIDTH = 2;

/** What a line holds that a terminal draws as an image; a rule in front would move it. */
const isImage = (line: string) => line.includes("\x1b_G") || line.includes("\x1b]1337;File=");

const paintWith = (theme: FoldTheme | undefined) => (key: string, text: string) => {
	try { return theme ? theme.fg(key, text) : text; } catch { return text; }
};

/** One group's line: a blank line above, as Pi's rows have, then the summary; a hung line has no blank line. */
export class FoldRow implements Component {
	open = false;
	private facts: FoldFacts = { tools: [], live: false, tokens: 0 };
	private look: FoldLook = { hung: false, open: false };
	private drawing?: { key: string; facts: FoldFacts; theme: FoldTheme | undefined; lines: string[] };
	private readonly host: FoldHost;
	/** The rule's end under an open group; a click on it closes the group. */
	readonly end: Component;

	constructor(host: FoldHost) {
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

/**
 * A row drawn `dx` columns to the right, without its first `dy` lines (a
 * blank line dropped): clicks reach it where it drew them.
 */
class Placed implements Component {
	private readonly child: Component;
	private readonly dx: number;
	private readonly dy: number;

	constructor(child: Component, dx: number, dy: number) {
		this.child = child;
		this.dx = dx;
		this.dy = dy;
	}

	render(width: number): string[] {
		return this.child.render(Math.max(1, width - this.dx)).slice(this.dy);
	}

	invalidate(): void {
		this.child.invalidate();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		return this.child.handleMouse?.({ ...event, x: event.x - this.dx, y: event.y + this.dy, width: Math.max(1, event.width - this.dx), height: event.height + this.dy });
	}
}

/** Lines without a blank first line; what that line held that draws nothing (Pi's zone marks) moves to the next. */
function withoutLead(lines: readonly string[]): { lines: string[]; dropped: number } {
	const head = lines[0];
	if (lines.length < 2 || head === undefined || visibleWidth(head) !== 0 || isImage(head)) return { lines: [...lines], dropped: 0 };
	return { lines: [head + lines[1]!, ...lines.slice(2)], dropped: 1 };
}

/** What the view draws for one group this frame. */
interface Drawn {
	readonly row: FoldRow;
	readonly facts: FoldFacts;
	readonly open: boolean;
	readonly hung: boolean;
}

/** The group's first row, folded or not: its line is kept by it. */
const firstOf = (group: FoldGroup): number => Math.min(group.members[0] ?? Infinity, group.said[0] ?? Infinity);

/** The phase spinner's spinner for each, 3 cells wide (SPINNER_SLOT_WIDTH): its sonar for every wait before the first token. */
const SPINNERS: Readonly<Record<FoldPhase, GlyphAnimation>> = {
	wait: MODE_SPINNERS.first_token, think: MODE_SPINNERS.think, tool: MODE_SPINNERS.tool, run: MODE_SPINNERS.run, peer: MODE_SPINNERS.peer,
};

/** A call that is written: whether it waits on another agent, and whether Pi has started it. */
interface Run {
	readonly peer: boolean;
	readonly started: boolean;
}

/**
 * What the model does now in a live group, as the phase spinner names it: a
 * call that runs; else a call it writes, though calls it wrote before wait
 * for the reply to end; else one about to run; else whether its newest reply
 * thinks. Thinking counts once it has text; until then it waits.
 */
function phaseOf(runs: readonly Run[], writes: boolean, streaming: Reply | undefined): FoldPhase {
	const started = runs.filter((run) => run.started);
	const shown = started.length > 0 || writes ? started : runs;
	if (shown.length > 0) return shown.every((run) => run.peer) ? "peer" : "run";
	if (writes) return "tool";
	const last = streaming?.lastMessage?.content.at(-1);
	return last?.type === "thinking" && typeof last.thinking === "string" && last.thinking.trim() !== "" ? "think" : "wait";
}

/** The reply each tool row belongs to: Pi adds a reply's rows right after it. */
function ownerOf(children: readonly Component[], index: number): Reply | undefined {
	for (let at = index - 1; at >= 0; at--) {
		const child = children[at];
		if (isReply(child)) return child;
	}
	return undefined;
}

export class FoldView {
	private readonly host: FoldHost;
	/** Each group's line, kept by its first row so a click's choice outlasts the frame. */
	private readonly rows = new WeakMap<Component, FoldRow>();
	/** Replies in this transcript; the subagent inspector draws Pi's replies too, and keeps their thinking. */
	private readonly ours = new WeakSet<object>();
	/** Replies whose group is open, so their thinking shows. */
	private readonly opened = new WeakSet<object>();
	/** Replies whose open group is a line of thinking alone, so their thinking shows in full. */
	private readonly revealed = new WeakSet<object>();
	/** What each reply was last built with: true when without its thinking. */
	private readonly built = new WeakMap<object, boolean>();
	/** A settled group's facts, kept until one of its rows changes. */
	private readonly settled = new WeakMap<FoldRow, { key: string; facts: FoldFacts }>();

	constructor(host: FoldHost) {
		this.host = host;
	}

	/** Asked as a reply is built: leave out its thinking? Yes in this transcript, unless its group is open. */
	foldsThinking(reply: object): boolean {
		const folds = this.host.enabled() && this.ours.has(reply) && !this.opened.has(reply);
		this.built.set(reply, folds);
		return folds;
	}

	/** Asked as a reply's thinking draws: show it in full? Yes when its open group is a line of thinking alone. */
	expandsThinking(reply: object): boolean {
		return this.host.enabled() && this.revealed.has(reply);
	}

	render(chat: Box, width: number): string[] {
		const children = chat.children;
		for (const child of children) if (isReply(child)) this.ours.add(child);
		const kinds = children.map(kindOf);
		// Rows that fold are drawn once the plan says how wide; the rest now, since their height can split a group.
		const drawn: Array<string[] | undefined> = children.map((child, index) => (FOLDING.has(kinds[index]!) ? undefined : child.render(width)));
		const plan = planFold(kinds.map((kind, index) => ({ kind, height: drawn[index]?.length ?? 0 })));
		const groups = this.groups(children, plan, drawn);
		groups.forEach((group, at) => this.reveal(children, plan.groups[at]!, group.open && thoughtOnly(group.facts)));
		const open = plan.groups.flatMap((group, at) => (groups[at]!.open ? [...group.members, ...group.said] : []));
		for (const index of this.rebuild(children, open)) drawn[index] = undefined;
		// A group's rows keep the width they have when it opens, so opening it draws nothing again.
		const widths = new Map<number, number>();
		groups.forEach((group, at) => {
			const { members, dropped } = plan.groups[at]!;
			for (const index of [...members, ...dropped]) widths.set(index, Math.max(1, width - group.row.ruleWidth()));
		});
		const rows = children.map((child, index) => drawn[index] ?? child.render(widths.get(index) ?? width));
		const lines: string[] = [];
		const layout: Array<{ component: Component; height: number }> = [];
		const put = (component: Component, drawnRows: readonly string[]) => {
			layout.push({ component, height: drawnRows.length });
			for (const row of drawnRows) lines.push(row);
		};
		/** Replies right under a line of their thinking alone, which lose their blank line. */
		const tucked = new Set<number>();
		let live = false;
		for (const entry of plan.entries) {
			if (entry.kind === "item") {
				const child = children[entry.index]!;
				const tight = tucked.has(entry.index) ? withoutLead(rows[entry.index]!) : undefined;
				if (tight?.dropped) put(new Placed(child, 0, tight.dropped), tight.lines);
				else put(child, rows[entry.index]!);
				continue;
			}
			const group = plan.groups[entry.group]!;
			const { row, facts, open: shown } = groups[entry.group]!;
			if (!shown && !facts.live && facts.tools.length === 0 && facts.tokens === 0) continue;
			// Live with nothing done yet: no call and no thinking. The phase spinner shows the wait.
			if (facts.live && facts.tools.length === 0 && facts.thoughtMs === undefined && facts.phase !== "think") continue;
			// Only a line drawn is live: the phase spinner yields its motion to it.
			live ||= facts.live;
			put(row, row.render(width));
			if (thoughtOnly(facts)) for (const index of group.said) tucked.add(index);
			if (shown) this.drawRun(row, [...group.members, ...group.dropped].sort((a, b) => a - b), children, rows, width, put);
		}
		chat.mouseLayout = { width, children: layout };
		this.host.animate(live);
		return lines;
	}

	/** Each group's line, facts and look. A click flips a group from what Pi's expand key (ctrl+o) chose for every row. */
	private groups(children: readonly Component[], plan: FoldPlan, drawn: ReadonlyArray<string[] | undefined>): Drawn[] {
		const before = new Map<number, PlanEntry | undefined>();
		plan.entries.forEach((entry, at) => { if (entry.kind === "group") before.set(entry.group, plan.entries[at - 1]); });
		return plan.groups.map((group, at) => {
			const row = this.rowFor(children[firstOf(group)]!);
			const expanded = group.members.some((index) => (children[index] as Partial<ToolRow>).expanded === true);
			// Calls right after the reply that made them hang under it, when it shows.
			const prior = before.get(at);
			const head = children[group.members[0] ?? -1];
			const hung = !!head && isToolRow(head) && prior?.kind === "item" && isReply(children[prior.index]) && drawn[prior.index]?.length !== 0;
			const facts = this.factsFor(row, children, group);
			const open = row.open !== expanded;
			row.update(facts, { hung, open });
			return { row, facts, open, hung };
		});
	}

	private reveal(children: readonly Component[], group: FoldGroup, shows: boolean): void {
		for (const index of [...group.members, ...group.said]) {
			const child = children[index];
			if (!isReply(child)) continue;
			if (shows) this.revealed.add(child);
			else this.revealed.delete(child);
		}
	}

	/** An open group's rows in a rule under its line, the first without its blank line, then the rule's end. */
	private drawRun(row: FoldRow, members: readonly number[], children: readonly Component[], rows: readonly string[][], width: number, put: (component: Component, lines: readonly string[]) => void): void {
		if (members.length === 0) return;
		const rule = row.rule();
		const dx = row.ruleWidth();
		const ruled = (line: string) => {
			if (isImage(line)) return line;
			return width > dx ? rule + line : truncateToWidth(rule + line, width, "");
		};
		let first = true;
		for (const index of members) {
			const own = rows[index]!;
			const tight = first && own.length > 0 ? withoutLead(own) : { lines: own, dropped: 0 };
			if (own.length > 0) first = false;
			put(new Placed(children[index]!, dx, tight.dropped), tight.lines.map(ruled));
		}
		put(row.end, row.end.render(width));
	}

	private rowFor(first: Component): FoldRow {
		const row = this.rows.get(first) ?? new FoldRow(this.host);
		this.rows.set(first, row);
		return row;
	}

	/**
	 * Builds again each reply whose thinking should now show or hide: one in a
	 * group that opened or closed, or one Pi built before it was in the
	 * transcript. Returns where they are, to be drawn again.
	 */
	private rebuild(children: readonly Component[], open: readonly number[]): number[] {
		const opening = new Set(open.map((index) => children[index]));
		const rebuilt: number[] = [];
		children.forEach((child, index) => {
			if (!isReply(child)) return;
			if (opening.has(child)) this.opened.add(child);
			else this.opened.delete(child);
			const folds = !opening.has(child);
			if (this.built.get(child) === folds) return;
			// Noted first: a reply the thinking patch passes over (an unexpected shape) is then not built again every frame.
			this.built.set(child, folds);
			child.invalidate();
			rebuilt.push(index);
		});
		return rebuilt;
	}

	/** The facts again only while the group is live or one of its rows changed; a long transcript has many settled groups. */
	private factsFor(row: FoldRow, children: readonly Component[], group: FoldGroup): FoldFacts {
		const busy = this.host.busy();
		let changing = false;
		// What can change in a settled group: a call's result arriving, its end time, a reply finishing.
		let key = `${busy}|${group.last}|`;
		for (const index of group.members) {
			const child = children[index]!;
			if (isToolRow(child)) {
				changing ||= child.isPartial;
				const nested = this.nestedOf(child.toolCallId);
				key += `${child.isPartial ? "p" : child.result?.isError ? "e" : "d"}${this.host.toolEndedAt(child.toolCallId) ?? ""}${nested ? `n${nested.map((call) => call.status[0]).join("")}` : ""},`;
			} else if (isReply(child)) {
				changing ||= child.isStreaming;
				key += child.isStreaming ? "s," : "r,";
			}
		}
		// A reply streaming its words below the line has finished the group's work, so it doesn't keep the line live.
		for (const index of group.said) key += (children[index] as Partial<Reply>).isStreaming ? "S," : "R,";
		const live = busy && (group.last || changing);
		const kept = this.settled.get(row);
		if (!live && kept?.key === key) return kept.facts;
		const facts = this.facts(children, group, live, busy);
		if (live) this.settled.delete(row);
		else this.settled.set(row, { key, facts });
		return facts;
	}

	private nestedOf(toolCallId: string): readonly NestedFact[] | undefined {
		try { return this.host.nestedOf(toolCallId); } catch { return undefined; }
	}

	private thoughtOf(message: ReplyMessage, live = false): number | undefined {
		try { return this.host.thoughtMs(message, live); } catch { return undefined; }
	}

	private facts(children: readonly Component[], group: FoldGroup, live: boolean, busy: boolean): FoldFacts {
		const tools: ToolFact[] = [];
		const replies = new Set<Reply>();
		const callers = new Set<Reply>();
		/** The group's own replies, as against those whose calls it holds; the newest one streaming. */
		const own: Reply[] = [];
		let streaming: Reply | undefined;
		const runs: Run[] = [];
		let writes = false;
		let ended: number | undefined;
		for (const index of group.members) {
			const child = children[index]!;
			if (isReply(child)) {
				replies.add(child);
				own.push(child);
				if (child.isStreaming) streaming = child;
				continue;
			}
			if (!isToolRow(child)) continue;
			const owner = ownerOf(children, index);
			// A reply that thought and spoke counts once, in the group that holds its thinking;
			// here its calls start when it stopped thinking.
			if (owner && speaks(owner.lastMessage) && thought(owner.lastMessage)) callers.add(owner);
			else if (owner) replies.add(owner);
			const running = child.isPartial && busy;
			const writing = running && child.argsComplete === false && child.executionStarted !== true && this.host.written?.(child.toolCallId) !== true;
			// An older Pi has no executionStarted; its written calls read as started.
			if (running && !writing) runs.push({ peer: isBlockingPeer(child.toolName, child.args), started: child.executionStarted !== false });
			writes ||= writing;
			tools.push(...factsOfCall(child.toolName, child.args, !child.isPartial && child.result?.isError === true, this.nestedOf(child.toolCallId)));
			const at = this.host.toolEndedAt(child.toolCallId);
			if (at !== undefined) ended = Math.max(ended ?? at, at);
		}
		for (const index of group.said) {
			const child = children[index];
			if (isReply(child)) replies.add(child);
		}
		let tokens = 0;
		let sent = 0;
		let started: number | undefined;
		for (const caller of callers) {
			const message = caller.lastMessage;
			if (typeof message?.timestamp !== "number") continue;
			const at = message.timestamp + (this.thoughtOf(message) ?? 0);
			started = Math.min(started ?? at, at);
		}
		for (const reply of replies) {
			const message = reply.lastMessage;
			if (!message) continue;
			tokens += tokensOf(message, reply.isStreaming);
			sent += sentOf(message);
			if (typeof message.timestamp !== "number") continue;
			started = Math.min(started ?? message.timestamp, message.timestamp);
			// A reply ends its share of the work when it stops thinking; without a time, where it started.
			const thoughtFor = this.thoughtOf(message);
			const at = message.timestamp + (thoughtFor ?? 0);
			if (!reply.isStreaming || thoughtFor !== undefined) ended = Math.max(ended ?? at, at);
		}
		const end = live ? this.host.now() : ended;
		const elapsedMs = started !== undefined && end !== undefined && end > started ? end - started : undefined;
		if (!live) return { tools, live, tokens, sent, ...(elapsedMs !== undefined ? { elapsedMs } : {}) };
		const thoughtMs = this.thinkingSoFar(own);
		return { tools, live, tokens, sent, ...(elapsedMs !== undefined ? { elapsedMs } : {}), phase: phaseOf(runs, writes, streaming), ...(thoughtMs !== undefined ? { thoughtMs } : {}) };
	}

	/** How long the replies have thought, counting only thinking with text: a provider can open a block and send none. */
	private thinkingSoFar(replies: readonly Reply[]): number | undefined {
		let total: number | undefined;
		for (const reply of replies) {
			const message = reply.lastMessage;
			if (!message || !thought(message)) continue;
			const ms = this.thoughtOf(message, true);
			if (ms !== undefined) total = (total ?? 0) + ms;
		}
		return total;
	}
}

interface Slot {
	/** Lines for the transcript, or undefined for Pi's own; replaced, never wrapped again, by a reload. */
	draw: ((width: number) => string[] | undefined) | undefined;
	readonly own: (width: number) => string[];
}

// On the container and keyed globally, so a reloaded copy of this module takes over the one patch.
const SLOT = Symbol.for("pi-extras.fold.v1");

/**
 * Draws `chat` through `view` while `enabled`, until the returned undo is
 * called; Pi's own render stays underneath. When the view throws, that frame
 * is Pi's own and `failed` hears of it.
 */
export function installFold(chat: Box, view: FoldView, enabled: () => boolean, failed: (error: unknown) => void = () => undefined): () => void {
	const hooked = chat as Box & { [SLOT]?: Slot };
	let slot = hooked[SLOT];
	if (!slot) {
		const created: Slot = { draw: undefined, own: chat.render.bind(chat) };
		slot = created;
		hooked[SLOT] = created;
		chat.render = (width: number) => {
			let lines: string[] | undefined;
			try {
				lines = created.draw?.(width);
			} catch {
				// Pi's transcript must still draw.
				lines = undefined;
			}
			return lines ?? created.own(width);
		};
	}
	const draw = (width: number) => {
		if (!enabled()) return undefined;
		try {
			return view.render(chat, width);
		} catch (error) {
			failed(error);
			return undefined;
		}
	};
	slot.draw = draw;
	const owned = slot;
	return () => {
		if (owned.draw === draw) owned.draw = undefined;
	};
}
