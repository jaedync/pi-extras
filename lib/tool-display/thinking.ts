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
import { BULLET_GLYPH } from "../band/glyph.ts";
import { ROW_MARGIN } from "../band/band.ts";
import { sanitize } from "./format.ts";

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
export function tailLines(text: string, width: number, max = THINKING_TAIL_LINES): { lines: string[]; cut: boolean } {
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

/** Live thinking belongs below the spinner, never inside the model's transcript. */
export function renderThinkingTail(text: string, width: number, theme: ThinkingTheme | undefined): string[] {
	if (!text.trim() || width <= 0) return [];
	const pad = "  ";
	const tail = tailLines(text, Math.max(1, width - pad.length));
	return tail.lines.map((line, index) => {
		const body = `${tail.cut && index === 0 ? TAIL_MARK : ""}${line}`;
		const colored = theme?.fg("dim", body) ?? body;
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

/** Swaps each of Pi's thinking regions for a view of the same rendering; false when the message doesn't look as expected. */
function restyle(self: Internals, message: Message, host: ThinkingHost, mode: ThinkingMode): boolean {
	const runs = thinkingRuns(message.content);
	const children = self.contentContainer.children;
	const regions = children.filter((child): child is Component & { child: Component } => isRegion(child));
	if (regions.length !== runs.length) return false;
	const owner = self as object;
	if (host.gutter?.()) {
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
	const hiddenSpacers = new Set<Component>();
	regions.forEach((region, run) => {
		const summary = host.summary;
		// Only the final thinking run can still be live. Later text or a call closes it.
		const last = message.content.at(-1);
		const live = !!summary && self.isStreaming && run === runs.length - 1 && last?.type === "thinking";
		if (live) {
			const at = children.indexOf(region);
			const spacer = children[at - 1];
			// Pi's spacer belongs to the hidden block, not to a reserved thinking-tail row.
			if (spacer?.constructor.name === "Spacer") hiddenSpacers.add(spacer);
			children[at] = { render: () => [], invalidate() {} };
			return;
		}
		const view = new ThinkingView({
			full: host.gutter?.() ? assistantText(region.child, false, host) : region.child,
			text: runs[run]!,
			pad: host.gutter?.() ? summary ? 0 : ROW_MARGIN : self.outputPad,
			host,
			view: () => {
				const chosen = viewFor(summary && host.mode() !== "full" ? "collapsed" : host.mode() ?? mode, self.hideThinkingBlock !== host.hiddenAtStart(), clicked.get(owner)?.has(run) ?? false);
				return summary && chosen === "tail" ? "collapsed" : chosen;
			},
			label: () => summary?.(message, run) ?? self.hiddenThinkingLabel,
			toggle: () => toggleBlock(owner, run),
			memo: memoFor(owner, run, runs[run]!, self.isStreaming, self.outputPad),
		});
		children[children.indexOf(region)] = view;
	});
	if (hiddenSpacers.size) self.contentContainer.children = children.filter((child) => !hiddenSpacers.has(child));
	return true;
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
			const mode = host.mode();
			if (!mode) return original.call(self, message, isStreaming);
			const hide = self.hideThinkingBlock;
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
