/**
 * Streaming thinking appears under the spinner as its newest three wrapped
 * lines. Finished thinking is one measured summary, expandable by click or
 * Pi's thinking toggle. The full view is Pi's own markdown rendering.
 * Older hosts retain the original three-view behavior.
 *
 * Pi draws an assistant message with its AssistantMessageComponent and has
 * no hook for thinking blocks, so this wraps the component's `updateContent`.
 * Pi builds the message with every thinking block visible, then each block
 * is swapped for a view that draws it in the chosen style: the full style is
 * Pi's own rendering (the same wrapping, colors and markdown). Anything
 * unexpected leaves Pi's rendering as it was.
 */
import { AssistantMessageComponent } from "@earendil-works/pi-coding-agent";
import type { Component, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { stripTerminalSequences, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { noteLate } from "../late-rows.ts";
import { BULLET_GLYPH, THOUGHT_GLYPH } from "../band/glyph.ts";
import { ROW_MARGIN } from "../band/band.ts";
import { glowing, glowLines, type GlowTheme, type Trail } from "../band/glow.ts";
import { elapsed } from "../fold/summary.ts";
import { sanitize } from "./format.ts";
import { livePlace } from "./live-thinking.ts";

export type ThinkingMode = "tail" | "collapsed" | "full";
export const THINKING_MODES: readonly ThinkingMode[] = ["tail", "collapsed", "full"];
/** Wrapped lines a tail keeps. */
export const THINKING_TAIL_LINES = 3;
/** Opens a cut tail's first line; the tail is wrapped this much narrower so it still fits. */
export const TAIL_MARK = "… ";

export interface ThinkingTheme {
	fg(key: string, text: string): string;
	italic?(text: string): string;
}

export interface ThinkingHost {
	/** The resting style, or undefined to leave thinking blocks to Pi. */
	mode(): ThinkingMode | undefined;
	/** Pi's hide-thinking setting when the session started; a message that differs has been toggled. */
	hiddenAtStart(): boolean;
	theme(): ThinkingTheme | undefined;
	/** Enables spinner-owned live thinking and the transcript's display-only finished label. */
	summary?(message: Message, run: number): string;
	gutter?(): boolean;
	/** Fold mode: this reply shows no thinking at all, and no spacing for it. */
	folds?(reply: object): boolean;
	/** Fold mode: this reply's thinking was opened from its Thought line, so it shows in full; that line is its label, so it never folds to another. */
	expands?(reply: object): boolean;
	/** Fold mode: this reply's group is open, so its live thinking shows here rather than in the phase spinner's tail. */
	opens?(reply: object): boolean;
	/** Pi's hide-thinking setting, as each reply in Pi's transcript is built or toggled (ctrl+t). */
	hidden?(hide: boolean): void;
}

// Global, so a reloaded copy of this module and the subagent inspector's copy read the same mark.
const ASIDE = Symbol.for("pi-extras.thinking.aside.v1");

/**
 * Marks a reply drawn outside Pi's transcript (the subagent inspector). No
 * phase spinner draws its live thinking, so the reply shows it itself, and
 * Pi's thinking toggle does not reach it.
 */
export function markAside(reply: object): void {
	(reply as Record<symbol, unknown>)[ASIDE] = true;
}

const isAside = (reply: object): boolean => (reply as Record<symbol, unknown>)[ASIDE] === true;

/** The glyph, then `Thought for 12.3s`: the time as a fold line says it, so the same thinking reads the same everywhere. */
export function thoughtLabel(ms: number | undefined): string {
	return ms === undefined ? `${THOUGHT_GLYPH} Thought` : `${THOUGHT_GLYPH} Thought for ${elapsed(ms)}`;
}

type Content = { type: string; thinking?: unknown; text?: unknown };
type Message = { timestamp?: number; content: readonly Content[] };

/** The parts of Pi's component this reads and writes. */
interface Internals {
	contentContainer: { children: Component[] };
	hideThinkingBlock: boolean;
	thinkingVisibilityOverrides: Map<number, boolean>;
	hiddenThinkingLabel: string;
	outputPad: number;
	isStreaming: boolean;
	lastMessage?: Message;
}

/** The runs of consecutive thinking blocks Pi draws, one per run, in order; empty runs are skipped as Pi skips them. */
export function thinkingRuns(content: readonly Content[]): string[] {
	const runs: string[] = [];
	for (let index = 0; index < content.length; index++) {
		if (content[index]!.type !== "thinking") continue;
		const texts: string[] = [];
		for (; index < content.length && content[index]!.type === "thinking"; index++) {
			const thinking = content[index]!.thinking;
			if (typeof thinking === "string" && thinking.trim()) texts.push(thinking.trim());
		}
		index--;
		if (texts.length > 0) runs.push(texts.join("\n\n"));
	}
	return runs;
}

/**
 * Where each run of thinkingRuns sits among all the runs, empty ones too:
 * the thinking timer counts every run, so a label reads its time by this index.
 */
export function thinkingRunIndices(content: readonly Content[]): number[] {
	const indices: number[] = [];
	let run = -1;
	content.forEach((part, index) => {
		if (part.type !== "thinking") return;
		if (content[index - 1]?.type !== "thinking") run++;
		if (typeof part.thinking === "string" && part.thinking.trim() && indices.at(-1) !== run) indices.push(run);
	});
	return indices;
}

/** The reply streams thinking now: a thinking block with text ends it. An empty block a provider opens does not count. */
export function thinksNow(content: readonly Content[]): boolean {
	for (let index = content.length - 1; index >= 0 && content[index]!.type === "thinking"; index--) {
		const thinking = content[index]!.thinking;
		if (typeof thinking === "string" && thinking.trim()) return true;
	}
	return false;
}

/** The style a block is drawn in: the resting one, or its opposite when toggled once (by click or Pi's key). */
export function viewFor(mode: ThinkingMode, toggledAll: boolean, toggledBlock: boolean): ThinkingMode {
	const other = mode === "full" ? "tail" : "full";
	return toggledAll !== toggledBlock ? other : mode;
}

/** Joins a paragraph or list item to the text before it; the no-break space keeps `·` off the start of a line. */
export const JOIN = "\u00a0· ";
/** Characters from the end of a block wrapped per line of the tail; plenty, so a long block costs the same as a short one. */
const TAIL_CHARS_PER_LINE = 3;

/** Markdown that marks a line (a heading, list item or quote) rather than being part of what it says. */
const LINE_MARKER = /^(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)+/;
const HEADING = /^#{1,6}\s/;
/** A code fence line. */
const FENCE = /^\s*(?:`{3,}|~{3,})/;

/**
 * A thinking block as one run of text. A line that only continues its
 * paragraph joins with a space, as Markdown would draw it; a new paragraph,
 * list item, heading or code line joins with `·`, or with a space after a
 * sentence ends. Heading, list and quote markers and fences go, as do bold,
 * code and strikethrough marks, and a link keeps its words.
 */
export function flatThinking(text: string): string {
	let out = "";
	let fresh = true;
	let code = false;
	for (const raw of sanitize(stripTerminalSequences(text)).split("\n")) {
		if (FENCE.test(raw)) {
			code = !code;
			fresh = true;
			continue;
		}
		const trimmed = raw.trim();
		const line = code ? trimmed : trimmed.replace(LINE_MARKER, "").trim();
		if (!line) {
			fresh = true;
			continue;
		}
		const starts = fresh || code || LINE_MARKER.test(trimmed);
		out = out === "" ? line : `${out}${!starts || /[.!?:;,]$/.test(out) ? " " : JOIN}${line}`;
		// A heading or code line is a block of its own, so what follows starts another.
		fresh = code || HEADING.test(trimmed);
	}
	return out
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/(\*\*|__|~~|`)/g, "")
		.replace(/[ \t]+/g, " ");
}

/**
 * The tail's lines at `width`: the whole block when it fits in `max` lines,
 * else its newest `max` with the first opening with `…`. Only the end of a
 * long block is wrapped.
 */
export function tailLines(text: string, width: number, max = THINKING_TAIL_LINES): { readonly lines: string[]; readonly cut: boolean } {
	// While new characters glow, every frame draws the tail; flattening the whole block again each time is the cost.
	if (lastTail?.text === text && lastTail.width === width && lastTail.max === max) return lastTail.tail;
	const tail = wrappedTail(text, width, max);
	lastTail = { text, width, max, tail };
	return tail;
}

let lastTail: { readonly text: string; readonly width: number; readonly max: number; readonly tail: { readonly lines: string[]; readonly cut: boolean } } | undefined;

function wrappedTail(text: string, width: number, max: number): { lines: string[]; cut: boolean } {
	const flat = flatThinking(text);
	const room = Math.max(1, width);
	const budget = room * max * TAIL_CHARS_PER_LINE;
	const long = flat.length > budget;
	const boundary = flat.indexOf(" ", flat.length - budget);
	const end = long ? flat.slice(boundary < 0 ? flat.length - budget : boundary + 1) : flat;
	if (!long) {
		const whole = wrapTextWithAnsi(end, room);
		if (whole.length <= max) return { lines: whole, cut: false };
	}
	const narrow = wrapTextWithAnsi(end, Math.max(1, room - TAIL_MARK.length));
	return { lines: narrow.slice(-max), cut: true };
}

/** New characters of a streamed text, and the time to draw them at. */
export interface TailGlow { readonly trail: Trail | undefined; readonly now: number }

/**
 * Live thinking belongs below the spinner, never inside the model's
 * transcript. With `glow`, new characters show brighter, then fade; the trail
 * counts the raw text, so a collapsed space in the tail shifts it a column.
 */
export function renderThinkingTail(text: string, width: number, theme: (ThinkingTheme & Partial<GlowTheme>) | undefined, glow?: TailGlow): string[] {
	if (!text.trim() || width <= 0) return [];
	const pad = "  ";
	const tail = tailLines(text, Math.max(1, width - pad.length));
	const lit = glow && theme && glowing(glow.trail, glow.now) ? glowLines(tail.lines, text.length, glow.trail, glow.now, theme, "dim") : undefined;
	return tail.lines.map((line, index) => {
		const mark = tail.cut && index === 0 ? TAIL_MARK : "";
		const colored = lit ? (mark ? theme!.fg("dim", mark) : "") + lit[index]! : theme?.fg("dim", mark + line) ?? mark + line;
		return truncateToWidth(pad + (theme?.italic?.(colored) ?? colored), width, "");
	});
}

export interface ViewOptions {
	/** Pi's own rendering of the block, in full. */
	readonly full: Component;
	/** The block's text, which the tail draws flattened. */
	readonly text: string;
	readonly view: () => ThinkingMode;
	/** Pi's label for a hidden block, shown in the collapsed style. */
	readonly label: () => string;
	readonly pad: number;
	readonly host: ThinkingHost;
	readonly toggle: () => void;
	/** Where the drawing is kept; shared by the views Pi's rebuilds make of an unchanged block. */
	readonly memo?: ViewMemo;
}

/** A block's last drawing and what it was drawn at. */
export interface ViewMemo {
	drawing?: { key: string; theme: ThinkingTheme | undefined; lines: string[] };
}

/**
 * One thinking block, drawn in the style `view` names on every frame. The
 * drawing depends only on the block's text, the width, style and theme, so
 * it is kept until one of them changes, even across Pi's rebuilds of the
 * message on every streamed token: Pi redraws the whole transcript every
 * frame, and wrapping a long block again each time is most of that work.
 */
export class ThinkingView implements Component {
	private readonly options: ViewOptions;
	private readonly memo: ViewMemo;

	constructor(options: ViewOptions) {
		this.options = options;
		this.memo = options.memo ?? {};
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		const view = this.options.view();
		const theme = this.options.host.theme();
		const key = `${width}|${view}|${view === "collapsed" ? this.options.label() : ""}`;
		const kept = this.memo.drawing;
		if (kept?.key === key && kept.theme === theme) return kept.lines;
		const lines = this.draw(width, view, theme).map((line) => truncateToWidth(line, width, ""));
		this.memo.drawing = { key, theme, lines };
		return lines;
	}

	private draw(width: number, view: ThinkingMode, theme: ThinkingTheme | undefined): string[] {
		const { full, pad } = this.options;
		if (view === "full") return full.render(width);
		const paint = (key: string, text: string) => {
			try { return theme ? theme.fg(key, text) : text; } catch { return text; }
		};
		const indent = " ".repeat(pad);
		if (view === "collapsed") {
			const italic = (text: string) => { try { return theme?.italic?.(text) ?? text; } catch { return text; } };
			return [indent + truncateToWidth(italic(paint(this.options.host.summary ? "dim" : "thinkingText", this.options.label())), Math.max(1, width - pad), "…")];
		}
		// Pi's Markdown keeps `pad` columns on each side; the tail keeps the same margins.
		const style = (text: string) => { const colored = paint("thinkingText", text); try { return theme?.italic?.(colored) ?? colored; } catch { return colored; } };
		const tail = tailLines(this.options.text, width - 2 * pad);
		return tail.lines.map((line, index) => indent + (tail.cut && index === 0 ? paint("thinkingText", TAIL_MARK) : "") + style(line));
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "click" || event.button !== "left") return undefined;
		this.options.toggle();
		return { handled: true };
	}

	invalidate(): void {
		this.memo.drawing = undefined;
		this.options.full.invalidate();
	}
}

const isRegion = (child: unknown): child is { child: Component } =>
	!!child && typeof child === "object" && "child" in child && "onMouse" in child;

/** Blocks a click switched, per message component: the choice outlives each rebuild while the message streams. */
const clicked = new WeakMap<object, Set<number>>();

/** Each block's drawing, per message component, kept while Pi rebuilds the message from the same block. */
const memos = new WeakMap<object, Map<number, { text: string; streaming: boolean; pad: number; memo: ViewMemo }>>();

function memoFor(owner: object, run: number, text: string, streaming: boolean, pad: number): ViewMemo {
	const byRun = memos.get(owner) ?? new Map();
	memos.set(owner, byRun);
	const kept = byRun.get(run);
	if (kept && kept.text === text && kept.streaming === streaming && kept.pad === pad) return kept.memo;
	// Pi's markdown can draw a streaming block differently, so a finished one is drawn again.
	const memo: ViewMemo = {};
	byRun.set(run, { text, streaming, pad, memo });
	return memo;
}

function toggleBlock(owner: object, run: number): void {
	const was = clicked.get(owner) ?? new Set<number>();
	clicked.set(owner, was.has(run) ? new Set([...was].filter((index) => index !== run)) : new Set([...was, run]));
}

/** Puts the reply's words and notices in the bullet gutter, the first words with the bullet. */
function inGutter(children: Component[], host: ThinkingHost): void {
	let first = true;
	for (let index = 0; index < children.length; index++) {
		const child = children[index]!;
		if (child.constructor.name === "Text") {
			children[index] = assistantText(child, false, host);
		// Copy Blocks may have swapped a reply's Markdown for its card view before this runs.
		} else if (child.constructor.name === "Markdown" || child.constructor.name === "CopyBlocksView") {
			children[index] = assistantText(child, first, host);
			first = false;
		}
	}
}

/** Swaps each of Pi's thinking regions for a view of the same rendering; false when the message doesn't look as expected. */
function restyle(self: Internals, message: Message, host: ThinkingHost, mode: ThinkingMode): boolean {
	const runs = thinkingRuns(message.content);
	const timed = thinkingRunIndices(message.content);
	const children = self.contentContainer.children;
	const regions = children.filter((child): child is Component & { child: Component } => isRegion(child));
	if (regions.length !== runs.length) return false;
	const owner = self as object;
	if (host.gutter?.()) inGutter(children, host);
	if (host.folds?.(owner)) {
		foldThinking(self, regions);
		return true;
	}
	const hiddenSpacers = new Set<Component>();
	// Only the final thinking run can still be live. Later text or a call closes it.
	const streams = !!host.summary && self.isStreaming && thinksNow(message.content);
	regions.forEach((region, run) => {
		const live = streams && run === runs.length - 1;
		const at = children.indexOf(region);
		if (live && !showsLive(self, host)) {
			const spacer = children[at - 1];
			// Pi's spacer belongs to the hidden block, not to a reserved thinking-tail row.
			if (spacer?.constructor.name === "Spacer") hiddenSpacers.add(spacer);
			children[at] = { render: () => [], invalidate() {} };
			return;
		}
		children[at] = new ThinkingView({
			full: host.gutter?.() ? assistantText(region.child, false, host) : region.child,
			text: runs[run]!,
			pad: host.gutter?.() ? host.summary ? 0 : ROW_MARGIN : self.outputPad,
			host,
			view: () => (live ? liveStyle(self, host, run) : finishedStyle(self, host, mode, run)),
			label: () => host.summary?.(message, timed[run] ?? run) ?? self.hiddenThinkingLabel,
			toggle: () => { if (live || !host.expands?.(owner)) toggleBlock(owner, run); },
			memo: memoFor(owner, run, runs[run]!, self.isStreaming, self.outputPad),
		});
	});
	if (hiddenSpacers.size) self.contentContainer.children = children.filter((child) => !hiddenSpacers.has(child));
	return true;
}

/** Pi's toggle (ctrl+t) was pressed since the session started; the inspector's replies take the setting as it was then. */
const toggledAll = (self: Internals, host: ThinkingHost) => self.hideThinkingBlock !== host.hiddenAtStart();

/** The live thinking shows in this reply: in an open fold group, or where no spinner draws it (see live-thinking.ts). */
function showsLive(self: Internals, host: ThinkingHost): boolean {
	// A closed group's reply was built without its thinking, so here fold mode draws it only when open.
	const opens = host.opens?.(self) === true;
	return livePlace({ folded: opens, open: opens, mode: host.mode(), toggled: toggledAll(self, host), aside: isAside(self) }) === "inline";
}

/** Live thinking rests as its tail, or in full in the full style; it has no label yet. */
function liveStyle(self: Internals, host: ThinkingHost, run: number): ThinkingMode {
	return viewFor(host.mode() === "full" ? "full" : "tail", toggledAll(self, host), clicked.get(self)?.has(run) ?? false);
}

/** Finished thinking rests as its label (the collapsed style) unless the style is full; under an open Thought line it stays in full. */
function finishedStyle(self: Internals, host: ThinkingHost, mode: ThinkingMode, run: number): ThinkingMode {
	if (host.expands?.(self)) return "full";
	const summary = !!host.summary;
	const resting = summary && host.mode() !== "full" ? "collapsed" : host.mode() ?? mode;
	const chosen = viewFor(resting, toggledAll(self, host), clicked.get(self)?.has(run) ?? false);
	return summary && chosen === "tail" ? "collapsed" : chosen;
}

const isSpacer = (child: Component | undefined) => child?.constructor.name === "Spacer";

/** Takes out each thinking block, the spacer Pi put after it, and a spacer left doubled. */
function foldThinking(self: Internals, regions: readonly Component[]): void {
	const children = self.contentContainer.children;
	const drop = new Set<Component>(regions);
	for (const region of regions) {
		const next = children[children.indexOf(region) + 1];
		if (isSpacer(next)) drop.add(next!);
	}
	const kept = children.filter((child) => !drop.has(child));
	self.contentContainer.children = kept.filter((child, index) => !(isSpacer(child) && (isSpacer(kept[index + 1]) || index === kept.length - 1)));
}

/**
 * A reply's rows in the bullet gutter. `child` stays writable: Copy Blocks
 * swaps a Markdown it finds here for its card view (see copy-blocks/view.ts).
 */
export class AssistantText implements Component {
	private cached?: { width: number; input: string[]; theme: ThinkingTheme | undefined; lines: string[] };
	child: Component;
	private readonly first: boolean;
	private readonly host: ThinkingHost;

	constructor(child: Component, first: boolean, host: ThinkingHost) {
		this.child = child;
		this.first = first;
		this.host = host;
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		const input = this.child.render(Math.max(1, width - ROW_MARGIN));
		const theme = this.host.theme();
		const cached = this.cached;
		if (cached?.width === width && cached.input === input && cached.theme === theme) return cached.lines;
		const lines = input.map((line, index) => {
			const mark = this.first && index === 0 ? `${theme?.fg("text", BULLET_GLYPH) ?? BULLET_GLYPH} ` : " ".repeat(ROW_MARGIN);
			return truncateToWidth(mark + line, width, "");
		});
		this.cached = { width, input, theme, lines };
		return lines;
	}

	invalidate(): void {
		this.cached = undefined;
		this.child.invalidate();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		return this.child.handleMouse?.({ ...event, x: event.x - ROW_MARGIN, width: Math.max(1, event.width - ROW_MARGIN) });
	}
}

export function assistantText(child: Component, first: boolean, host: ThinkingHost): Component {
	return new AssistantText(child, first, host);
}

type Update = (this: unknown, message: Message, isStreaming?: boolean) => void;
type SetHide = (this: unknown, hide: boolean) => void;

interface Impl {
	update(self: Internals, message: Message, isStreaming: boolean | undefined, original: Update): void;
	setHide(self: Internals, hide: boolean, original: SetHide): void;
}

interface Slot {
	impl: Impl | undefined;
	readonly updateContent: Update;
	readonly setHideThinkingBlock: SetHide;
}

// Kept on the prototype, so a reloaded copy of this module takes over the one patch instead of stacking another.
// Versioned, so an update that changes the patch lays its own over an older one (left passing straight through).
const SLOT = Symbol.for("pi-extras.thinking-tail.v2");

function implFor(host: ThinkingHost): Impl {
	return {
		update(self, message, isStreaming, original) {
			const hide = self.hideThinkingBlock;
			if (!isAside(self)) host.hidden?.(hide);
			const mode = host.mode();
			if (!mode) return original.call(self, message, isStreaming);
			const overrides = self.thinkingVisibilityOverrides;
			const pad = self.outputPad;
			if (host.gutter?.()) self.outputPad = 0;
			// Pi builds every block in full; the views pick what to show of it.
			self.hideThinkingBlock = false;
			self.thinkingVisibilityOverrides = new Map();
			try {
				original.call(self, message, isStreaming);
			} finally {
				self.hideThinkingBlock = hide;
				self.thinkingVisibilityOverrides = overrides;
				self.outputPad = pad;
			}
			let styled = false;
			try { styled = restyle(self, message, host, mode); } catch { styled = false; }
			if (!styled) original.call(self, message, isStreaming);
		},
		setHide(self, hide, original) {
			// Pi's toggle for every block resets the ones a click switched, as it resets its own.
			clicked.delete(self);
			if (!isAside(self)) host.hidden?.(hide);
			original.call(self, hide);
		},
	};
}

/**
 * Draws thinking blocks through `host` until the returned undo is called.
 * The patch stays on Pi's prototype, passing straight through, once undone.
 */
export function installThinkingTail(host: ThinkingHost, target: object = AssistantMessageComponent.prototype): () => void {
	const owned = slotOf(target);
	const impl = implFor(host);
	owned.impl = impl;
	return () => {
		if (owned.impl === impl) owned.impl = undefined;
	};
}

/** Puts the patch on Pi's message with no host, passing straight through and noting each message it builds (see late-rows.ts). */
export function prepareThinkingTail(target: object = AssistantMessageComponent.prototype): void {
	slotOf(target);
}

function slotOf(target: object): Slot {
	const proto = target as Record<string | symbol, unknown> & { updateContent: Update; setHideThinkingBlock: SetHide };
	const found = proto[SLOT] as Slot | undefined;
	if (found) return found;
	const created: Slot = { impl: undefined, updateContent: proto.updateContent, setHideThinkingBlock: proto.setHideThinkingBlock };
	proto[SLOT] = created;
	proto.updateContent = function (message, isStreaming) {
		if (!created.impl) {
			noteLate("message", this as object);
			return created.updateContent.call(this, message, isStreaming);
		}
		created.impl.update(this as Internals, message, isStreaming, created.updateContent);
	};
	proto.setHideThinkingBlock = function (hide) {
		if (!created.impl) return created.setHideThinkingBlock.call(this, hide);
		created.impl.setHide(this as Internals, hide, created.setHideThinkingBlock);
	};
	return created;
}
