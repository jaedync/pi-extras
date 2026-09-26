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
import { truncateToWidth } from "@earendil-works/pi-tui";

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

/** The newest `max` lines of a rendered block, with the count of those above them. */
export function tailOf(lines: readonly string[], max: number): { lines: string[]; skipped: number } {
	let end = lines.length;
	while (end > 0 && lines[end - 1]!.trim() === "") end--;
	const start = Math.max(0, end - max);
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

/** One thinking block, drawn in the style `view` names on every frame. */
export class ThinkingView implements Component {
	private readonly options: ViewOptions;

	constructor(options: ViewOptions) {
		this.options = options;
	}

	render(width: number): string[] {
		const { full, pad, host } = this.options;
		const view = this.options.view();
		if (view === "full") return full.render(width);
		const theme = host.theme();
		const paint = (key: string, text: string) => {
			try { return theme ? theme.fg(key, text) : text; } catch { return text; }
		};
		const indent = " ".repeat(pad);
		if (view === "collapsed") {
			const italic = (text: string) => { try { return theme?.italic?.(text) ?? text; } catch { return text; } };
			return [indent + truncateToWidth(italic(paint("thinkingText", this.options.label())), Math.max(1, width - pad), "…")];
		}
		const whole = tailOf(full.render(width), THINKING_TAIL_LINES);
		if (whole.skipped === 0) return whole.lines;
		const narrow = Math.max(1, width - TAIL_MARK.length);
		const [first = "", ...rest] = tailOf(full.render(narrow), THINKING_TAIL_LINES).lines;
		const body = first.startsWith(indent) ? first.slice(pad) : first;
		return [indent + paint("thinkingText", TAIL_MARK) + body, ...rest];
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "click" || event.button !== "left") return undefined;
		this.options.toggle();
		return { handled: true };
	}

	invalidate(): void {
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
