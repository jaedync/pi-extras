/**
 * Fold mode: the transcript shows each run of work between replies as one
 * line (see plan.ts and summary.ts). A click on the line, or Pi's expand key
 * (ctrl+o), opens the group and shows its rows as usual.
 *
 * Pi has no hook for the transcript as a whole, so this wraps the render of
 * Pi's chat container, the third child of the document Pi mounts first. Every
 * row still renders on every frame, folded or not, because tool rows keep
 * their timing and animation state in their own render; a folded row's lines
 * are dropped. The container's mouse layout is written to match the lines,
 * so clicks land on the rows drawn. Any other layout is left alone.
 */
import { Spacer, Text, truncateToWidth, visibleWidth, type Component, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { glyphAt, JOB_ANIMATION } from "../band/glyph.ts";
import { planFold, type FoldGroup, type PlanItem } from "./plan.ts";
import { foldPhrase, foldStats, type FoldFacts, type ToolFact } from "./summary.ts";
import { CHARS_PER_TOKEN } from "../cc-phase.ts";

export interface FoldTheme {
	fg(key: string, text: string): string;
}

export interface ReplyMessage {
	readonly content: readonly { readonly type: string; readonly text?: unknown; readonly thinking?: unknown; readonly arguments?: unknown }[];
	readonly usage?: { readonly output?: number; readonly cost?: { readonly total?: number } };
	readonly timestamp?: number;
	readonly stopReason?: string;
	readonly provider?: string;
	readonly model?: string;
}

export interface FoldHost {
	enabled(): boolean;
	theme(): FoldTheme | undefined;
	/** An agent run is going. */
	busy(): boolean;
	now(): number;
	reduced(): boolean;
	costOf(message: ReplyMessage): number;
	/** When a call's result arrived, if known. */
	toolEndedAt(toolCallId: string): number | undefined;
	/** How long a reply thought, if known. */
	thoughtMs(message: ReplyMessage): number | undefined;
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

function classify(child: Component, height: number): PlanItem {
	if (isToolRow(child)) return { kind: "tool", height };
	if (isReply(child)) {
		const message = child.lastMessage;
		return { kind: !speaks(message) ? "work" : thought(message) ? "said" : "visible", height };
	}
	if (child instanceof Spacer) return { kind: "spacer", height };
	// Pi's status lines and notices (ThemedText extends Text) arrive mid-run and must not split a group.
	if (child instanceof Text) return { kind: "note", height };
	return { kind: "visible", height };
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

const OPEN_GLYPH = "▾";
const CLOSED_GLYPH = "▸";
const STATS_JOIN = " · ";
/** Columns the words keep before the figures give way. */
const MIN_WORDS = 16;

/** One group's line: a blank line above, as Pi's rows have, then the summary. */
export class FoldRow implements Component {
	open = false;
	private facts: FoldFacts = { tools: [], live: false, tokens: 0, cost: 0 };
	private shown = false;
	private drawing?: { key: string; facts: FoldFacts; theme: FoldTheme | undefined; lines: string[] };
	private readonly host: FoldHost;

	constructor(host: FoldHost) {
		this.host = host;
	}

	update(facts: FoldFacts, shown: boolean): void {
		this.facts = facts;
		this.shown = shown;
	}

	/** Kept while the facts (the same object while a group is settled), width, glyph and theme are unchanged. */
	render(width: number): string[] {
		const theme = this.host.theme();
		const { live } = this.facts;
		const glyph = live ? glyphAt(JOB_ANIMATION, this.host.now(), { reduced: this.host.reduced() }) : this.shown ? OPEN_GLYPH : CLOSED_GLYPH;
		const key = `${width}|${glyph}`;
		const kept = this.drawing;
		if (kept?.key === key && kept.facts === this.facts && kept.theme === theme) return kept.lines;
		const lines = this.draw(width, glyph, theme);
		this.drawing = { key, facts: this.facts, theme, lines };
		return lines;
	}

	/**
	 * One block on the left: the glyph, the words, then the figures after a
	 * `·`, as the end line reads. On a narrow line the words are cut first;
	 * the figures go only when even short words wouldn't fit beside them.
	 */
	private draw(width: number, glyph: string, theme: FoldTheme | undefined): string[] {
		const paint = (key: string, text: string) => {
			try { return theme ? theme.fg(key, text) : text; } catch { return text; }
		};
		const { live } = this.facts;
		const stats = foldStats(this.facts).join(STATS_JOIN);
		const phrase = foldPhrase(this.facts);
		const tone = live ? "text" : "toolOutput";
		const words = paint(tone, phrase.said)
			+ (phrase.failed ? paint(tone, ", ") + paint("error", phrase.failed) : "")
			+ paint(tone, `${phrase.after ? `, ${phrase.after}` : ""}${live ? "…" : ""}`);
		const tail = stats ? `${STATS_JOIN}${stats}` : "";
		const room = width - 3 - visibleWidth(tail);
		const fits = room >= MIN_WORDS;
		const left = truncateToWidth(words, Math.max(1, fits ? room : width - 3), "…");
		const line = `${paint(live ? "accent" : "muted", glyph)} ${left}${fits ? paint("muted", tail) : ""}`;
		return ["", truncateToWidth(line, width, "")];
	}


	invalidate(): void {
		this.drawing = undefined;
	}

	/** A click on the summary line, not the blank line above it, opens or closes the group. */
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "click" || event.button !== "left" || event.y !== 1) return undefined;
		this.open = !this.open;
		this.host.redraw();
		return { handled: true };
	}
}

/** The group's first row, folded or not: its line is kept by it. */
const firstOf = (group: FoldGroup): number => Math.min(group.members[0] ?? Infinity, group.said[0] ?? Infinity);

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

	render(chat: Box, width: number): string[] {
		const children = chat.children;
		for (const child of children) if (isReply(child)) this.ours.add(child);
		const drawn = children.map((child) => child.render(width));
		const plan = planFold(children.map((child, index) => classify(child, drawn[index]!.length)));
		// A click flips a group from what Pi's expand key (ctrl+o) chose for every row.
		const shown = plan.groups.map((group) => {
			const row = this.rowFor(children[firstOf(group)]!);
			return row.open !== group.members.some((index) => (children[index] as Partial<ToolRow>).expanded === true);
		});
		this.rebuild(children, drawn, plan.groups.flatMap((group, at) => (shown[at] ? [...group.members, ...group.said] : [])), width);
		const lines: string[] = [];
		const layout: Array<{ component: Component; height: number }> = [];
		const put = (component: Component, rows: readonly string[]) => {
			layout.push({ component, height: rows.length });
			for (const row of rows) lines.push(row);
		};
		let live = false;
		for (const entry of plan.entries) {
			if (entry.kind === "item") {
				put(children[entry.index]!, drawn[entry.index]!);
				continue;
			}
			const group = plan.groups[entry.group]!;
			const row = this.rowFor(children[firstOf(group)]!);
			const facts = this.factsFor(row, children, group);
			live ||= facts.live;
			if (!shown[entry.group] && !facts.live && facts.tools.length === 0 && facts.tokens === 0) continue;
			row.update(facts, shown[entry.group]!);
			put(row, row.render(width));
			if (!shown[entry.group]) continue;
			for (const index of [...group.members, ...group.dropped].sort((a, b) => a - b)) put(children[index]!, drawn[index]!);
		}
		chat.mouseLayout = { width, children: layout };
		this.host.animate(live);
		return lines;
	}

	private rowFor(first: Component): FoldRow {
		const row = this.rows.get(first) ?? new FoldRow(this.host);
		this.rows.set(first, row);
		return row;
	}

	/**
	 * Builds again each reply whose thinking should now show or hide: one in a
	 * group that opened or closed, or one Pi built before it was in the transcript.
	 */
	private rebuild(children: readonly Component[], drawn: string[][], open: readonly number[], width: number): void {
		const opening = new Set(open.map((index) => children[index]));
		children.forEach((child, index) => {
			if (!isReply(child)) return;
			if (opening.has(child)) this.opened.add(child);
			else this.opened.delete(child);
			const folds = !opening.has(child);
			if (this.built.get(child) === folds) return;
			// Noted first: a reply the thinking patch passes over (an unexpected shape) is then not built again every frame.
			this.built.set(child, folds);
			child.invalidate();
			drawn[index] = child.render(width);
		});
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
				key += `${child.isPartial ? "p" : child.result?.isError ? "e" : "d"}${this.host.toolEndedAt(child.toolCallId) ?? ""},`;
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

	private thoughtOf(message: ReplyMessage): number | undefined {
		try { return this.host.thoughtMs(message); } catch { return undefined; }
	}

	private facts(children: readonly Component[], group: FoldGroup, live: boolean, busy: boolean): FoldFacts {
		const tools: ToolFact[] = [];
		const replies = new Set<Reply>();
		const callers = new Set<Reply>();
		let ended: number | undefined;
		for (const index of group.members) {
			const child = children[index]!;
			if (isReply(child)) {
				replies.add(child);
				continue;
			}
			if (!isToolRow(child)) continue;
			const owner = ownerOf(children, index);
			// A reply that thought and spoke counts once, in the group that holds its thinking;
			// here its calls start when it stopped thinking.
			if (owner && speaks(owner.lastMessage) && thought(owner.lastMessage)) callers.add(owner);
			else if (owner) replies.add(owner);
			const running = child.isPartial && busy;
			tools.push({ name: child.toolName, running, failed: !child.isPartial && child.result?.isError === true });
			const at = this.host.toolEndedAt(child.toolCallId);
			if (at !== undefined) ended = Math.max(ended ?? at, at);
		}
		for (const index of group.said) {
			const child = children[index];
			if (isReply(child)) replies.add(child);
		}
		let tokens = 0;
		let cost = 0;
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
			try { cost += this.host.costOf(message); } catch { /* A reply without a price adds nothing. */ }
			if (typeof message.timestamp !== "number") continue;
			started = Math.min(started ?? message.timestamp, message.timestamp);
			// A reply ends its share of the work when it stops thinking; without a time, where it started.
			const thoughtFor = this.thoughtOf(message);
			const at = message.timestamp + (thoughtFor ?? 0);
			if (!reply.isStreaming || thoughtFor !== undefined) ended = Math.max(ended ?? at, at);
		}
		const end = live ? this.host.now() : ended;
		const elapsedMs = started !== undefined && end !== undefined && end > started ? end - started : undefined;
		return { tools, live, tokens, cost, ...(elapsedMs !== undefined ? { elapsedMs } : {}) };
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
