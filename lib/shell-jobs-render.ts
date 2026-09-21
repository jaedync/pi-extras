/**
 * Presentation for the shell job tools and completion messages.
 *
 * This deliberately mirrors pi's built-in bash renderer: the call line reads
 * `$ command`, long bodies collapse to the last few lines behind the expand hint,
 * a truncated log gets the bracketed warning banner, and the run time lands in a
 * muted "Took" footer. Imports of the pi packages resolve to the host instance
 * through the extension loader's aliases, so the theme and the keybinding hint
 * come from the running app rather than a bundled copy.
 */
import { Box, MouseRegion, Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { keyHint, truncateToVisualLines, type MessageRenderer, type Theme } from "@earendil-works/pi-coding-agent";
import { commandPreview, DURATION_PATTERN, formatDuration, MAX_COMMAND_BYTES, sanitizeControl, titlePreview } from "./shell-jobs-core.ts";

const TITLE_DURATION_SUFFIX = new RegExp(` after ${DURATION_PATTERN}$`);

/** Matches the built-in bash preview so the two call styles agree. */
export const PREVIEW_LINES = 5;

export type PaintKey = "toolTitle" | "toolOutput" | "muted" | "dim" | "warning" | "success" | "error";
export type BgKey = "toolSuccessBg" | "toolErrorBg";

export interface Paint {
	fg(key: PaintKey, text: string): string;
	bg(key: BgKey, text: string): string;
	bold(text: string): string;
}

/** A theme missing a key must degrade to plain text, not break the row. */
export function painter(theme: Theme): Paint {
	const fg = (key: PaintKey, text: string): string => {
		try {
			return theme.fg(key, text);
		} catch {
			return text;
		}
	};
	return {
		fg,
		// A finished tool call carries toolSuccessBg or toolErrorBg, so completions
		// painted with the same backgrounds read as the same kind of thing.
		bg: (key, text) => {
			try {
				return theme.bg(key, text);
			} catch {
				return text;
			}
		},
		bold: (text) => {
			try {
				return theme.bold(text);
			} catch {
				return text;
			}
		},
	};
}

/**
 * `keyHint` reads the live keybinding table, which pi only initializes once the
 * interactive theme exists. Tests and headless runs take the plain fallback.
 */
function expandHint(theme: Theme, paint: Paint): string {
	try {
		return keyHint("app.tools.expand", "to expand");
	} catch {
		return `${paint.fg("dim", "ctrl+o")}${paint.fg("muted", " to expand")}`;
	}
}

function previewHint(theme: Theme, paint: Paint, skipped: number): string {
	const label = `... (${skipped} earlier line${skipped === 1 ? "" : "s"}, `;
	return `${paint.fg("muted", label)}${expandHint(theme, paint)}${paint.fg("muted", ")")}`;
}

/** Text blocks of a tool result or message content, flattened in order. */
export function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: string; text?: unknown } => typeof part === "object" && part !== null)
		.filter((part) => part.type === "text")
		.map((part) => String(part.text ?? ""))
		.join("\n");
}

/** The `$ <command>` text and its muted cwd suffix, before the title styling. */
function commandParts(args: unknown, paint: Paint, flatten: boolean): { shown: string; suffix: string } {
	const record = (args ?? {}) as { command?: unknown; cwd?: unknown };
	const raw = typeof record.command === "string" ? record.command : null;
	const cwd = typeof record.cwd === "string" ? record.cwd : "";
	const command = raw === null ? null : flatten ? commandPreview(raw, MAX_COMMAND_BYTES) : sanitizeControl(raw);
	const shown = command === null ? paint.fg("error", "[invalid arg]") : command.length > 0 ? command : paint.fg("toolOutput", "...");
	const suffix = cwd.length > 0 ? paint.fg("muted", ` (cwd ${cwd})`) : "";
	return { shown, suffix };
}

/** `$ <command>` exactly as the bash tool renders it, plus an explicit cwd. */
export function startCallLine(args: unknown, paint: Paint): string {
	const { shown, suffix } = commandParts(args, paint, false);
	return paint.fg("toolTitle", paint.bold(`$ ${shown}`)) + suffix;
}

/**
 * Header lines of a start call. Without a title this is the bash-style line.
 * With one, the title leads in the tool colour and the command follows muted,
 * flattened to a single line that is cut at the width until the row is
 * expanded, so the label is what the eye lands on but the command never
 * disappears from the transcript.
 */
export function startCallLines(args: unknown, paint: Paint, width: number, expanded: boolean): string[] {
	const title = titlePreview((args as { title?: unknown } | null)?.title);
	if (title === null) return [startCallLine(args, paint)];
	const { shown, suffix } = commandParts(args, paint, !expanded);
	// Paint before cutting so the truncation closes the colour sequence itself.
	const command = paint.fg("muted", `$ ${shown}${suffix}`);
	const line = expanded ? command : truncateToWidth(command, Math.max(1, width), "\u2026");
	return [paint.fg("toolTitle", paint.bold(title)), line];
}

/** `shell_job logs j1`, with the paging arguments that matter kept visible. */
export function jobCallLine(args: unknown, paint: Paint): string {
	const record = (args ?? {}) as { op?: unknown; id?: unknown; offset?: unknown; tail?: unknown; bytes?: unknown; limit?: unknown };
	const op = typeof record.op === "string" ? record.op : "";
	const id = typeof record.id === "string" ? record.id : "";
	const extras: string[] = [];
	if (typeof record.offset === "number") extras.push(`offset ${record.offset}`);
	if (record.tail === true) extras.push("tail");
	if (typeof record.bytes === "number") extras.push(`${record.bytes} bytes`);
	if (typeof record.limit === "number") extras.push(`limit ${record.limit}`);
	const suffix = extras.length > 0 ? paint.fg("muted", ` (${extras.join(", ")})`) : "";
	return paint.fg("toolTitle", paint.bold(`shell_job ${op}${id.length > 0 ? ` ${id}` : ""}`)) + suffix;
}

export interface CompletionView {
	title: string;
	/** The job's model-supplied label from details; empty when it had none. */
	label: string;
	failed: boolean;
	/** Bounded preview of the command, from details; empty for a message without one. */
	command: string;
	meta: string[];
	body: string;
	notice: string;
	took: string;
}

/**
 * Split a completion message into the parts the renderer styles. The message is
 * built as `head`, blank line, body, blank line, optional notice, so the body may
 * itself contain blank lines and cannot be found by splitting on every `\n\n`.
 */
export function splitCompletionText(text: string): { head: string; body: string; notice: string } {
	const firstBreak = text.indexOf("\n\n");
	if (firstBreak === -1) return { head: text, body: "", notice: "" };
	const head = text.slice(0, firstBreak);
	let rest = text.slice(firstBreak + 2);
	let notice = "";
	if (rest.endsWith("]")) {
		const at = rest.lastIndexOf("\n\n[");
		if (at !== -1 && rest.slice(at).includes("Full output:")) {
			notice = rest.slice(at + 2);
			rest = rest.slice(0, at);
		}
	}
	return { head, body: rest.trimEnd(), notice };
}

export function completionView(content: unknown, details: unknown): CompletionView {
	const text = textOf(content).replace(/\r/g, "");
	const { head: headBlock, body, notice } = splitCompletionText(text);
	const head = headBlock.split("\n");
	const record = (details ?? {}) as { code?: unknown; signal?: unknown; durationMs?: unknown; command?: unknown; title?: unknown };
	const code = typeof record.code === "number" ? record.code : null;
	const signal = typeof record.signal === "string" ? record.signal : null;
	const durationMs = typeof record.durationMs === "number" ? record.durationMs : null;
	// The title line exists for the model; the header shows the label instead.
	const meta = head.slice(1).filter((line) => !line.startsWith("title: "));
	// The message names the log on its own line, so the notice need not repeat the
	// path (which is long enough to wrap the whole line in a narrow terminal).
	const logPath = meta.map((line) => /^log: (.+)$/.exec(line)?.[1]).find((path) => path !== undefined);
	const suffix = logPath === undefined ? "" : `. Full output: ${logPath}]`;
	return {
		// The duration is rendered in the footer, so it leaves the title.
		title: (head[0] ?? "").replace(TITLE_DURATION_SUFFIX, ""),
		label: titlePreview(record.title) ?? "",
		failed: signal !== null || (code !== null && code !== 0),
		command: typeof record.command === "string" ? record.command : "",
		meta,
		body,
		notice: suffix.length > 0 && notice.endsWith(suffix) ? `${notice.slice(0, -suffix.length)}]` : notice,
		took: durationMs === null ? "" : formatDuration(durationMs),
	};
}

/**
 * Collapsed bodies show the last lines, like bash, because the interesting part of
 * a failing command is at the end. Wrapped-line accounting is width dependent, so
 * the result is cached until the width or the expanded state changes.
 */
class PreviewBody implements Component {
	private readonly text: string;
	private readonly paddingX: number;
	private readonly isExpanded: () => boolean;
	private readonly hint: (skipped: number) => string;
	private width: number | undefined;
	private expanded: boolean | undefined;
	private lines: string[] | undefined;
	private skipped = 0;
	private full: string[] | undefined;

	constructor(text: string, paddingX: number, isExpanded: () => boolean, hint: (skipped: number) => string) {
		this.text = text;
		this.paddingX = paddingX;
		this.isExpanded = isExpanded;
		this.hint = hint;
	}

	invalidate(): void {
		this.width = undefined;
		this.lines = undefined;
		this.full = undefined;
	}

	render(width: number): string[] {
		const expanded = this.isExpanded();
		if (expanded) {
			if (this.full === undefined || this.width !== width) {
				this.full = new Text(this.text, this.paddingX, 0).render(width);
				this.width = width;
				this.lines = undefined;
			}
			return ["", ...this.full];
		}
		if (this.lines === undefined || this.width !== width || this.expanded !== expanded) {
			const preview = truncateToVisualLines(this.text, PREVIEW_LINES, width, this.paddingX);
			this.lines = preview.visualLines;
			this.skipped = preview.skippedCount;
			this.width = width;
			this.expanded = expanded;
		}
		const head = this.skipped > 0 ? [this.hint(this.skipped)] : [];
		return ["", ...head, ...(this.lines ?? [])];
	}
}

function styledBody(body: string, paint: Paint): string {
	return body
		.split("\n")
		.map((line) => paint.fg("toolOutput", line))
		.join("\n");
}

/**
 * Header of a `shell_job_start` row. The width and the row's expanded state
 * decide how the command under a title is shown, so this renders lazily rather
 * than fixing the text up front. Pi re-invokes the renderer when the expanded
 * flag changes, so the state is read at render time from the context.
 */
class StartCallHeader implements Component {
	constructor(
		private readonly args: unknown,
		private readonly paint: Paint,
		private readonly isExpanded: () => boolean,
	) {}

	invalidate(): void {}

	render(width: number): string[] {
		return new Text(startCallLines(this.args, this.paint, width, this.isExpanded()).join("\n"), 0, 0).render(width);
	}
}

/** Call header for `shell_job_start`, rendered like the built-in bash tool. */
export function renderStartCall(args: unknown, theme: Theme, context?: { expanded?: boolean }): Component {
	return new StartCallHeader(args, painter(theme), () => context?.expanded === true);
}

/** Call line for the management tool. */
export function renderJobCall(args: unknown, theme: Theme): Text {
	return new Text(jobCallLine(args, painter(theme)), 0, 0);
}

/**
 * Result of `shell_job_start`: the id, pid and log path under a blank line, the
 * way bash separates its output from the call line. It is short, so it never
 * collapses.
 */
export function renderStartResult(result: unknown, theme: Theme): Component {
	const record = (result ?? {}) as { content?: unknown };
	const text = textOf(record.content).replace(/\r/g, "").trimEnd();
	return new Text(`\n${styledBody(text, painter(theme))}`, 0, 0);
}

/** Result body for `shell_job`, collapsed to the tail like bash output. */
export function renderJobResult(result: unknown, options: { expanded: boolean }, theme: Theme): Component {
	const record = (result ?? {}) as { content?: unknown };
	const paint = painter(theme);
	const text = textOf(record.content).replace(/\r/g, "").trimEnd();
	// Pi wraps tool results in its own expand-on-click region, so this only has to
	// collapse; the tool row's Box supplies the padding.
	return new PreviewBody(styledBody(text, paint), 0, () => options.expanded, (skipped) => previewHint(theme, paint, skipped));
}

/**
 * Renderer for `shell-job-complete` messages.
 *
 * The result is framed like a finished bash tool call: a Box carrying the same
 * success or error background, and a mouse region that expands the body on click,
 * which pi does for tool rows but not for custom messages. Expansion is tracked per
 * message because the interactive mode owns the global expand flag; toggling that
 * flag (ctrl+O) clears the per-message choice so the global one keeps winning.
 */
export function createCompletionRenderer(): MessageRenderer {
	const overrides = new WeakMap<object, boolean>();
	const globalSeen = new WeakMap<object, boolean>();
	return (message, options, theme) => {
		const view = completionView(message.content, message.details);
		if (view.title.length === 0) return undefined;
		const key = message as object;
		if (globalSeen.get(key) !== options.expanded) {
			overrides.delete(key);
			globalSeen.set(key, options.expanded);
		}
		const isExpanded = (): boolean => overrides.get(key) ?? options.expanded;
		const paint = painter(theme);
		const parts: Component[] = [];
		const header = view.label.length > 0 ? `${view.label} \u00b7 ${view.title}` : view.title;
		parts.push(new Text(paint.fg(view.failed ? "error" : "success", paint.bold(header)), 0, 0));
		// The command sits under the title so the reader need not scroll back to the
		// start call to learn what j1 was; the log path follows in the same tone.
		const under = [...(view.command.length > 0 ? [`$ ${view.command}`] : []), ...view.meta];
		if (under.length > 0) parts.push(new Text(under.map((line) => paint.fg("muted", line)).join("\n"), 0, 0));
		if (view.body.length > 0) {
			const body = new PreviewBody(styledBody(view.body, paint), 0, isExpanded, (skipped) => previewHint(theme, paint, skipped));
			parts.push(body);
		}
		if (view.notice.length > 0) parts.push(new Text(`\n${paint.fg("warning", view.notice)}`, 0, 0));
		if (view.took.length > 0) parts.push(new Text(`\n${paint.fg("muted", `Took ${view.took}`)}`, 0, 0));
		const box = new Box(options.outputPad, 1, (text) => paint.bg(view.failed ? "toolErrorBg" : "toolSuccessBg", text));
		box.addChild(containerOf(parts));
		return new MouseRegion(box, (event) => {
			if (event.type !== "click" || event.button !== "left") return undefined;
			overrides.set(key, !isExpanded());
			box.invalidate();
			return { handled: true };
		});
	};
}

function containerOf(parts: Component[]): Component {
	return {
		invalidate(): void {
			for (const part of parts) part.invalidate?.();
		},
		render(width: number): string[] {
			return parts.flatMap((part) => part.render(width));
		},
	};
}
