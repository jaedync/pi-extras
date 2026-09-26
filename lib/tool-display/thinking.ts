/**
 * Thinking blocks as a live tail: a block of up to three wrapped lines shows
 * whole; a longer one shows its newest three, the first opening with `…`.
 * A click on a block, or Pi's thinking toggle for all of them, switches to
 * the full text and back. The resting style can also be Pi's collapsed label
 * or the full text.
 *
 * Pi draws an assistant message with its AssistantMessageComponent and has
 * no hook for thinking blocks, so this wraps the component's `updateContent`.
 * Pi builds the message with every thinking block visible, then each block
 * is swapped for a view that draws Pi's own rendering of it (the same
 * wrapping, colors and markdown) in the chosen style. Anything unexpected
 * leaves Pi's rendering as it was.
 */
import { AssistantMessageComponent } from "@earendil-works/pi-coding-agent";
import type { Component, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { Markdown, truncateToWidth } from "@earendil-works/pi-tui";

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
}

type Content = { type: string; thinking?: unknown; text?: unknown };
type Message = { content: readonly Content[] };

/** The parts of Pi's component this reads and writes; all present in Pi 0.87. */
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

/** Below this width a cut tail's lines could differ from the whole's, so the whole is wrapped. */
const CUT_MIN_WIDTH = 20;
/** The shortest end of a block worth wrapping alone; it grows until it fills the tail. */
const CUT_START_CHARS = 1_500;
/** Markdown that reaches across blank lines (link definitions, HTML blocks), which a cut could change. */
const CUT_UNSAFE = /^ {0,3}\[[^\]]+\]:|<!--|<(?:pre|script|style|textarea)\b/im;
/** A paragraph or heading, not a list item, quote, table, HTML or indented code. */
const CUT_LINE = /^(?![-*+>|<\d\s])/;

/**
 * Offsets where a paragraph or heading starts after a blank line, outside any
 * code fence. Markdown from there on draws exactly as it does within the whole.
 */
export function paragraphStarts(text: string): number[] {
	const starts: number[] = [];
	let fence: { char: string; size: number } | undefined;
	let blank = false;
	let offset = 0;
	for (const line of text.split("\n")) {
		const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
		if (fence) {
			if (marker && marker[0] === fence.char && marker.length >= fence.size && line.trim() === marker) fence = undefined;
		} else if (marker) {
			fence = { char: marker[0]!, size: marker.length };
		} else if (blank && offset > 0 && CUT_LINE.test(line)) {
			starts.push(offset);
		}
		blank = line.trim() === "";
		offset += line.length + 1;
	}
	return starts;
}

/**
 * The newest lines of a long Markdown block, wrapped from a late paragraph
 * rather than from the top, so a block that is still streaming costs the same
 * to draw however long it has grown. Undefined when that isn't safe or the
 * block is short; the caller then wraps the whole.
 */
export function cutTail(full: Component, width: number, max: number): string[] | undefined {
	if (!(full instanceof Markdown) || width < CUT_MIN_WIDTH) return undefined;
	const block = full as unknown as { text: string; paddingX: number; paddingY: number; theme: never; defaultTextStyle: never; options: never };
	const text = block.text;
	if (typeof text !== "string" || block.paddingY !== 0 || text.length < CUT_START_CHARS * 2 || CUT_UNSAFE.test(text)) return undefined;
	const starts = paragraphStarts(text);
	for (let want = CUT_START_CHARS; want < text.length; want *= 4) {
		const cut = starts.findLast((start) => start <= text.length - want);
		if (cut === undefined) return undefined;
		const part = new Markdown(text.slice(cut), block.paddingX, 0, block.theme, block.defaultTextStyle, block.options);
		const shown = tailOf(part.render(width), max);
		// More lines than the tail keeps, so the whole is longer than the tail too.
		if (shown.skipped > 0) return shown.lines;
	}
	return undefined;
}

/** The newest `max` lines of a rendered block, less any blank ones it would open with, and the count of those above them. */
export function tailOf(lines: readonly string[], max: number): { lines: string[]; skipped: number } {
	let end = lines.length;
	while (end > 0 && lines[end - 1]!.trim() === "") end--;
	let start = Math.max(0, end - max);
	// A tail that opens on the gap between paragraphs starts at the next one instead.
	while (start < end - 1 && lines[start]!.trim() === "") start++;
	return { lines: lines.slice(start, end), skipped: start };
}

export interface ViewOptions {
	/** Pi's own rendering of the block, in full. */
	readonly full: Component;
	readonly view: () => ThinkingMode;
	/** Pi's label for a hidden block, shown in the collapsed style. */
	readonly label: () => string;
	readonly pad: number;
	readonly host: ThinkingHost;
	readonly toggle: () => void;
}

/**
 * One thinking block, drawn in the style `view` names on every frame. Pi
 * rebuilds the view whenever the message changes, so its drawing depends only
 * on the width, style and theme and is kept until one of them changes: Pi
 * redraws the whole transcript every frame, and the tail's narrower render
 * would otherwise throw away Pi's own cached wrapping each time.
 */
export class ThinkingView implements Component {
	private readonly options: ViewOptions;
	private cache: { key: string; theme: ThinkingTheme | undefined; lines: string[] } | undefined;

	constructor(options: ViewOptions) {
		this.options = options;
	}

	render(width: number): string[] {
		const view = this.options.view();
		if (view === "full") return this.options.full.render(width);
		const theme = this.options.host.theme();
		const key = `${width}|${view}|${view === "collapsed" ? this.options.label() : ""}`;
		if (this.cache?.key === key && this.cache.theme === theme) return this.cache.lines;
		const lines = this.draw(width, view, theme);
		this.cache = { key, theme, lines };
		return lines;
	}

	private draw(width: number, view: Exclude<ThinkingMode, "full">, theme: ThinkingTheme | undefined): string[] {
		const { full, pad } = this.options;
		const paint = (key: string, text: string) => {
			try { return theme ? theme.fg(key, text) : text; } catch { return text; }
		};
		const indent = " ".repeat(pad);
		if (view === "collapsed") {
			const italic = (text: string) => { try { return theme?.italic?.(text) ?? text; } catch { return text; } };
			return [indent + truncateToWidth(italic(paint("thinkingText", this.options.label())), Math.max(1, width - pad), "…")];
		}
		const narrow = Math.max(1, width - TAIL_MARK.length);
		let lines = cutTail(full, narrow, THINKING_TAIL_LINES);
		if (!lines) {
			const cut = tailOf(full.render(narrow), THINKING_TAIL_LINES);
			// Two more columns can only fold a block into the tail's three lines when it is barely longer, so only a short block is wrapped twice.
			if (cut.skipped + cut.lines.length <= 2 * THINKING_TAIL_LINES + 2 || narrow < CUT_MIN_WIDTH) {
				const whole = tailOf(full.render(width), THINKING_TAIL_LINES);
				if (whole.skipped === 0) return whole.lines;
			}
			lines = cut.lines;
		}
		const [first = "", ...rest] = lines;
		const body = first.startsWith(indent) ? first.slice(pad) : first;
		return [indent + paint("thinkingText", TAIL_MARK) + body, ...rest];
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "click" || event.button !== "left") return undefined;
		this.options.toggle();
		return { handled: true };
	}

	invalidate(): void {
		this.cache = undefined;
		this.options.full.invalidate();
	}
}

const isRegion = (child: unknown): child is { child: Component } =>
	!!child && typeof child === "object" && "child" in child && "onMouse" in child;

/** Blocks a click switched, per message component: the choice outlives each rebuild while the message streams. */
const clicked = new WeakMap<object, Set<number>>();

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
	regions.forEach((region, run) => {
		const view = new ThinkingView({
			full: region.child,
			pad: self.outputPad,
			host,
			view: () => viewFor(host.mode() ?? mode, self.hideThinkingBlock !== host.hiddenAtStart(), clicked.get(owner)?.has(run) ?? false),
			label: () => self.hiddenThinkingLabel,
			toggle: () => toggleBlock(owner, run),
		});
		children[children.indexOf(region)] = view;
	});
	return true;
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
const SLOT = Symbol.for("pi-extras.thinking-tail");

function implFor(host: ThinkingHost): Impl {
	return {
		update(self, message, isStreaming, original) {
			const mode = host.mode();
			if (!mode) return original.call(self, message, isStreaming);
			const hide = self.hideThinkingBlock;
			const overrides = self.thinkingVisibilityOverrides;
			// Pi builds every block in full; the views pick what to show of it.
			self.hideThinkingBlock = false;
			self.thinkingVisibilityOverrides = new Map();
			try {
				original.call(self, message, isStreaming);
			} finally {
				self.hideThinkingBlock = hide;
				self.thinkingVisibilityOverrides = overrides;
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
	const proto = target as Record<string | symbol, unknown> & { updateContent: Update; setHideThinkingBlock: SetHide };
	let slot = proto[SLOT] as Slot | undefined;
	if (!slot) {
		const created: Slot = { impl: undefined, updateContent: proto.updateContent, setHideThinkingBlock: proto.setHideThinkingBlock };
		proto[SLOT] = created;
		proto.updateContent = function (message, isStreaming) {
			if (!created.impl) return created.updateContent.call(this, message, isStreaming);
			created.impl.update(this as Internals, message, isStreaming, created.updateContent);
		};
		proto.setHideThinkingBlock = function (hide) {
			if (!created.impl) return created.setHideThinkingBlock.call(this, hide);
			created.impl.setHide(this as Internals, hide, created.setHideThinkingBlock);
		};
		slot = created;
	}
	const owned = slot;
	const impl = implFor(host);
	owned.impl = impl;
	return () => {
		if (owned.impl === impl) owned.impl = undefined;
	};
}
