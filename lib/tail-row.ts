/**
 * Lines right under the transcript, above the messages queued for the agent:
 * where the phase spinner shows what the agent is doing, so the spinner sits
 * where the work is and the queue reads as what comes next.
 *
 * Pi has no extension slot there. Widgets go below its queued messages, and
 * its layout is private: the same seven containers in regular and fullscreen
 * mode (transcript, queued messages, status, widgets, editor, widgets,
 * footer), kept when it switches modes. So the lines are drawn as the first
 * lines of the queued-messages container, found by its place next to the
 * editor this package wrapped. Any other layout is left alone, and the caller
 * draws its lines somewhere else.
 */

type Draw = (width: number) => string[];

interface Hook {
	draw: Draw | undefined;
}

interface Box {
	children: unknown[];
	render(width: number): string[];
}

/** Pi's layout in 0.87 through 0.99: the queue follows the transcript, the editor comes fifth. */
const LAYOUT_SIZE = 7;
const QUEUE_AT = 1;
const EDITOR_AT = 4;
/** How deep our editor may sit inside other extensions' wrappers. */
const MAX_WRAP_DEPTH = 8;

// On the container and keyed globally, so reloads and a second copy of this package share one hook.
const HOOK = Symbol.for("pi-extras.tail-row.v1");

function isBox(value: unknown): value is Box {
	if (!value || typeof value !== "object") return false;
	const box = value as Partial<Box>;
	return Array.isArray(box.children) && typeof box.render === "function";
}

/** Whether `outer` is `editor`, or wraps it through `base` links (WrappedEditor). */
function wraps(outer: unknown, editor: object): boolean {
	let current = outer;
	for (let depth = 0; depth < MAX_WRAP_DEPTH && current && typeof current === "object"; depth++) {
		if (current === editor) return true;
		current = (current as { base?: unknown }).base;
	}
	return false;
}

/** Pi's queued-messages container, when `tui` holds Pi's layout around `editor`. */
export function queueContainer(tui: unknown, editor: object): Box | undefined {
	const children = (tui as { children?: unknown } | undefined)?.children;
	if (!Array.isArray(children) || children.length !== LAYOUT_SIZE) return undefined;
	const holder = children.findIndex((child) => isBox(child) && child.children.some((inner) => wraps(inner, editor)));
	if (holder !== EDITOR_AT) return undefined;
	const queue = children[QUEUE_AT];
	return isBox(queue) ? queue : undefined;
}

/** The container's hook, installed once: its render draws the hook's lines, then its own. */
function hookOf(queue: Box): Hook {
	const hooked = queue as Box & { [HOOK]?: Hook };
	const existing = hooked[HOOK];
	if (existing) return existing;
	const hook: Hook = { draw: undefined };
	const own = queue.render.bind(queue);
	hooked[HOOK] = hook;
	queue.render = (width: number) => {
		const lines = own(width);
		let extra: string[] = [];
		try {
			extra = hook.draw?.(width) ?? [];
		} catch {
			// Pi's queue must still draw.
		}
		return extra.length > 0 ? [...extra, ...lines] : lines;
	};
	return hook;
}

export class TailRow {
	private hook: Hook | undefined;
	private draw: Draw | undefined;

	get attached(): boolean {
		return this.hook !== undefined;
	}

	/** Draws `draw`'s lines above Pi's queued messages; false when `tui` isn't Pi's layout. */
	attach(tui: unknown, editor: object, draw: Draw): boolean {
		if (this.hook) return true;
		const queue = queueContainer(tui, editor);
		if (!queue) return false;
		this.hook = hookOf(queue);
		this.hook.draw = draw;
		this.draw = draw;
		return true;
	}

	/** Stops drawing, unless a newer owner (after a reload) has taken the hook since. */
	detach(): void {
		if (this.hook && this.hook.draw === this.draw) this.hook.draw = undefined;
		this.hook = undefined;
		this.draw = undefined;
	}
}
