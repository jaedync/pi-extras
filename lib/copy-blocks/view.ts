/**
 * An assistant reply's text, drawn by Pi's own Markdown component with code
 * blocks and quotes as cards a click copies.
 *
 * Pi draws an assistant message with its AssistantMessageComponent and has
 * no hook for code blocks, so this wraps the component's `updateContent`:
 * after Pi builds the message, each text block that has a fence or a quote
 * is swapped for a view that draws the same Markdown through a tagged theme
 * (scan.ts). Anything unexpected leaves Pi's rendering as it was.
 */
import { AssistantMessageComponent } from "@earendil-works/pi-coding-agent";
import type { Component, MarkdownTheme, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { draw, paintFrom, type Button, type PaintTheme } from "./draw.ts";
import { newRecorder, scan, taggedTheme, type Block, type Recorder } from "./scan.ts";
import { sourceBlocks, sourceCode, type SourceBlock } from "./source.ts";
import { noteLate } from "../late-rows.ts";

/** How long a label reads "copied" after a click. */
export const COPIED_MS = 1_500;

export interface CopyHost {
	/** False to leave replies to Pi. */
	enabled(): boolean;
	/** Whether clicks reach the transcript (Pi's fullscreen mode). */
	clickable(): boolean;
	theme(): PaintTheme | undefined;
	copy(text: string): Promise<void>;
	failed(error: unknown): void;
	/** Asks Pi to draw again, so the copied mark goes away while Pi is idle. */
	redraw?(): void;
	now?(): number;
}

/** The fields of Pi's Markdown this reads. */
interface PiMarkdown extends Component {
	text: string;
	paddingX: number;
	paddingY: number;
	theme: MarkdownTheme;
	defaultTextStyle?: unknown;
	options?: unknown;
}

/** The last click on a block of a message, per message component: it outlives Pi's rebuilds while a reply streams. */
const copiedAt = new WeakMap<object, { part: number; block: Block; at: number }>();

export class CopyBlocksView implements Component {
	private readonly inner: Component;
	private readonly recorder: Recorder = newRecorder();
	private readonly source: string;
	private sources?: SourceBlock[];
	private drawn?: { raw: string[]; width: number; theme: unknown; labels: boolean; copied: string; blocks: Block[]; lines: string[]; buttons: Button[] };

	private readonly original: PiMarkdown;
	private readonly host: CopyHost;
	/** The message component, which outlives the views Pi's rebuilds make. */
	private readonly owner: object;
	/** Which of the message's text blocks this is. */
	private readonly part: number;

	constructor(original: PiMarkdown, host: CopyHost, owner: object, part: number) {
		this.original = original;
		this.host = host;
		this.owner = owner;
		this.part = part;
		const Make = original.constructor as new (...args: unknown[]) => Component;
		this.source = original.text;
		this.inner = new Make(original.text, original.paddingX, original.paddingY, taggedTheme(original.theme, this.recorder), original.defaultTextStyle, original.options);
	}

	render(width: number): string[] {
		try {
			return this.draw(width).lines;
		} catch {
			return this.original.render(width);
		}
	}

	private draw(width: number) {
		this.recorder.pending = undefined;
		this.recorder.open = false;
		const raw = this.inner.render(width);
		if (this.recorder.pending) this.recorder.codes = this.recorder.pending;
		this.recorder.pending = undefined;
		const theme = this.host.theme();
		const labels = this.host.clickable();
		const copied = this.copied();
		const key = copied ? `${copied.kind}${copied.index}` : "";
		const kept = this.drawn;
		if (kept && kept.raw === raw && kept.width === width && kept.theme === theme && kept.labels === labels && kept.copied === key) return kept;
		const { lines, blocks } = scan(raw);
		const result = theme
			? draw({
				lines, blocks, width, labels, copied,
				pad: this.original.paddingX,
				paint: paintFrom(theme),
				langOf: (block) => this.recorder.codes[block.index]?.lang ?? "",
			})
			: { lines, buttons: [] };
		this.drawn = { raw, width, theme, labels, copied: key, blocks, ...result };
		return this.drawn;
	}

	private copied(): Block | undefined {
		const last = copiedAt.get(this.owner);
		const now = this.host.now?.() ?? Date.now();
		return last && last.part === this.part && now - last.at < COPIED_MS ? last.block : undefined;
	}

	/** The exact text a click on this block copies. */
	textOf(block: Block): string | undefined {
		this.sources ??= sourceBlocks(this.source);
		if (block.kind === "code") {
			const drawn = this.recorder.codes[block.index]?.code;
			return drawn === undefined ? undefined : sourceCode(drawn, this.sources);
		}
		// Quotes pair up by order only when the source has exactly the quotes Pi drew; one inside a list item, say, doesn't.
		const quotes = this.sources.filter((each) => each.kind === "quote");
		const drawn = this.drawn?.blocks.filter((each) => each.kind === "quote").length;
		return quotes.length === drawn ? quotes[block.index]?.text : undefined;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "click" || event.button !== "left") return undefined;
		// A card drawn later lies on top (a code block inside a quote), so its button wins.
		const button = this.drawn?.buttons.findLast((each) => each.row === event.y && event.x >= each.from && event.x < each.to);
		if (!button) return undefined;
		const text = this.textOf(button.block) ?? this.renderedText(button.block);
		copiedAt.set(this.owner, { part: this.part, block: button.block, at: this.host.now?.() ?? Date.now() });
		this.host.copy(text).catch((error: unknown) => {
			copiedAt.delete(this.owner);
			this.host.failed(error);
			this.host.redraw?.();
		});
		if (this.host.redraw) setTimeout(() => this.host.redraw?.(), COPIED_MS + 50).unref?.();
		return { handled: true, render: true };
	}

	/** The block as drawn, for a quote the source couldn't be matched to. */
	private renderedText(block: Block): string {
		const raw = this.inner.render(this.drawn?.width ?? 80);
		return scan(raw).lines.slice(block.start, block.end + 1)
			.map((line) => stripTerminalSequences(line).replace(/^\s*│ ?/, "").trimEnd())
			.join("\n");
	}

	invalidate(): void {
		this.drawn = undefined;
		this.inner.invalidate();
		this.original.invalidate();
	}
}

/** Worth a view: a fence or a quote somewhere in the text. */
const HAS_BLOCK = /```|~~~|^\s*>/m;

const isMarkdown = (child: unknown): child is PiMarkdown =>
	!!child && typeof child === "object" && (child as object).constructor?.name === "Markdown" && typeof (child as PiMarkdown).text === "string";

interface Internals {
	contentContainer: { children: Component[] };
}

/** Tool Display's bullet gutter (AssistantText in tool-display/thinking.ts), when it holds a reply's Markdown. */
const gutterOf = (child: unknown): { child: Component } | undefined => {
	const wrapper = child as { constructor?: { name?: string }; child?: unknown } | undefined;
	return wrapper?.constructor?.name === "AssistantText" && isMarkdown(wrapper.child) ? (wrapper as { child: Component }) : undefined;
};

/**
 * Swaps each text block Pi built for a view, inside Tool Display's gutter when
 * that patch ran first. Thinking sits inside a MouseRegion or a thinking view,
 * so only replies are direct children.
 */
export function adopt(self: Internals, host: CopyHost): void {
	const children = self.contentContainer.children;
	let part = 0;
	children.forEach((child, index) => {
		const gutter = gutterOf(child);
		const markdown = gutter?.child ?? child;
		if (!isMarkdown(markdown)) return;
		const at = part++;
		if (!HAS_BLOCK.test(markdown.text)) return;
		const view = new CopyBlocksView(markdown, host, self, at);
		if (gutter) gutter.child = view;
		else children[index] = view;
	});
}

type Update = (this: unknown, message: unknown, isStreaming?: boolean) => void;

interface Slot {
	host: CopyHost | undefined;
	readonly updateContent: Update;
}

// Kept on the prototype, so a reloaded copy of this module takes over the one patch instead of stacking another.
// Versioned, so an update that changes the patch lays its own over an older one (left passing straight through).
const SLOT = Symbol.for("pi-extras.copy-blocks.v2");

/**
 * Draws replies' blocks through `host` until the returned undo is called.
 * The patch stays on Pi's prototype, passing straight through, once undone.
 */
export function installCopyBlocks(host: CopyHost, target: object = AssistantMessageComponent.prototype): () => void {
	const owned = slotOf(target);
	owned.host = host;
	return () => {
		if (owned.host === host) owned.host = undefined;
	};
}

/** Puts the patch on Pi's message with no host, passing straight through and noting each message it builds (see late-rows.ts). */
export function prepareCopyBlocks(target: object = AssistantMessageComponent.prototype): void {
	slotOf(target);
}

function slotOf(target: object): Slot {
	const proto = target as Record<string | symbol, unknown> & { updateContent: Update };
	const found = proto[SLOT] as Slot | undefined;
	if (found) return found;
	const created: Slot = { host: undefined, updateContent: proto.updateContent };
	proto[SLOT] = created;
	proto.updateContent = function (message, isStreaming) {
		created.updateContent.call(this, message, isStreaming);
		const active = created.host;
		if (!active) noteLate("message", this as object);
		if (!active?.enabled()) return;
		try { adopt(this as Internals, active); } catch { /* Pi's rendering stays */ }
	};
	return created;
}
