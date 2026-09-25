/**
 * Presentation for the shell job tools and completion messages.
 *
 * Every row is a header band, as Tool Display draws a tool call: the start
 * row names the job (its title, or the command without one) and stays calm
 * while it runs in the background, the widget being the one that moves; the
 * completion message is the same band in the job's final color; a shell_job
 * row names the operation and the job it addressed. Output is hidden until
 * clicked or expanded, then sits indented under the band on the theme's
 * tool gray.
 */
import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { keyHint, type MessageRenderer, type Theme } from "@earendil-works/pi-coding-agent";
import { renderBand, type Seg } from "./band/band.ts";
import { paletteFrom } from "./band/palette.ts";
import { bodyBackground, onBackground } from "./band/surface.ts";
import { factsOf, jobBand, type JobFacts } from "./shell-jobs-band.ts";
import { DURATION_PATTERN, formatDuration, sanitizeControl, titlePreview } from "./shell-jobs-core.ts";
import type { Job } from "./shell-jobs-process.ts";

const TITLE_DURATION_SUFFIX = new RegExp(` after ${DURATION_PATTERN}$`);

/** Output lines under a collapsed row; the same as Tool Display's bash row. */
export const PREVIEW_LINES = 4;
/** Output sits under the band's title. */
export const BODY_INDENT = 3;

export type PaintKey = "toolTitle" | "toolOutput" | "muted" | "dim" | "warning" | "success" | "error" | "accent";

export interface Paint {
	fg(key: PaintKey, text: string): string;
	bold(text: string): string;
}

/** A theme missing a key must degrade to plain text, not break the row. */
export function painter(theme: Theme): Paint {
	const safe = (paint: () => string, text: string) => {
		try {
			return paint();
		} catch {
			return text;
		}
	};
	return { fg: (key, text) => safe(() => theme.fg(key, text), text), bold: (text) => safe(() => theme.bold(text), text) };
}

/**
 * `keyHint` reads the live keybinding table, which pi only initializes once the
 * interactive theme exists. Tests and headless runs take the plain fallback.
 */
function expandHint(): string {
	try {
		return keyHint("app.tools.expand", "to expand");
	} catch {
		return "ctrl+o to expand";
	}
}

/** Lines drawn on demand at the width they are given. */
class Lines implements Component {
	private readonly draw: (width: number) => string[];
	constructor(draw: (width: number) => string[]) {
		this.draw = draw;
	}
	render(width: number): string[] {
		return this.draw(Math.max(1, width));
	}
	invalidate(): void {}
}

/** Output under a band: its last lines while collapsed, all of it expanded. */
export function bodyLines(text: string, paint: Paint, width: number, expanded: boolean): string[] {
	const trimmed = text.replace(/\r/g, "").replace(/\n+$/, "");
	if (trimmed.trim() === "") return [];
	const inner = Math.max(1, width - BODY_INDENT);
	const pad = " ".repeat(BODY_INDENT);
	const all = trimmed.split("\n");
	const shown = expanded ? all : all.slice(-PREVIEW_LINES);
	const hidden = all.length - shown.length;
	const lines = shown.map((line) => pad + truncateToWidth(paint.fg("toolOutput", line), inner, "\u2026"));
	if (hidden === 0) return lines;
	const hint = `${paint.fg("muted", `\u2026 ${hidden} earlier line${hidden === 1 ? "" : "s"} (`)}${paint.fg("dim", expandHint())}${paint.fg("muted", ")")}`;
	return [pad + truncateToWidth(hint, inner, "\u2026"), ...lines];
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

interface RowContext {
	readonly isPartial?: boolean;
	readonly executionStarted?: boolean;
	readonly expanded?: boolean;
	readonly isError?: boolean;
}

/** What a start row knows before, or without, the job it started. */
function startFacts(args: unknown): JobFacts {
	const record = (args ?? {}) as { command?: unknown; title?: unknown };
	return {
		title: titlePreview(record.title),
		command: typeof record.command === "string" ? sanitizeControl(record.command) : "",
		state: "unknown",
		code: null,
		signal: null,
	};
}

/**
 * The `shell_job_start` row: one band naming the job. It follows the job it
 * started while this session owns it; a resumed row, whose job belongs to an
 * earlier session, just says it ran in the background.
 */
export function renderStartCall(args: unknown, theme: Theme, context?: RowContext, job: () => Job | undefined = () => undefined, now: () => number = Date.now): Component {
	return new Lines((width) => {
		const live = job();
		if (live !== undefined) return [jobBand(theme, factsOf(live), { width, now: now(), view: "calm" })];
		const facts = startFacts(args);
		if (context?.isPartial && !context.executionStarted) {
			const title = facts.title ?? facts.command;
			return [renderBand(theme, paletteFrom(theme), { width, phase: { kind: "writing" }, segs: title ? jobBandSegs(facts) : [], rail: [], clockMs: now() })];
		}
		if (context?.isError) return [renderBand(theme, paletteFrom(theme), { width, phase: { kind: "done", outcome: "fail", sinceMs: Number.POSITIVE_INFINITY }, segs: jobBandSegs(facts), rail: [{ text: "not started", color: "error" }], clockMs: now() })];
		return [jobBand(theme, facts, { width, now: now(), view: "calm" })];
	});
}

function jobBandSegs(facts: JobFacts): Seg[] {
	return facts.title !== null ? [{ text: facts.title, color: "text", bold: true }] : [{ text: "$ ", color: "accent", bold: true }, { text: facts.command.replace(/\s+/g, " ").trim(), color: "text" }];
}

/** The start result says where the job runs and logs; the row shows it only for an error, or expanded. */
export function renderStartResult(result: unknown, theme: Theme, context?: RowContext): Component {
	const text = textOf((result as { content?: unknown } | null)?.content).trimEnd();
	const paint = painter(theme);
	return new Lines((width) => {
		if (context?.isError) return onBackground(bodyLines(text, { ...paint, fg: (key, line) => paint.fg(key === "toolOutput" ? "error" : key, line) }, width, true), width, bodyBackground(theme));
		return context?.expanded ? onBackground(bodyLines(text, paint, width, true), width, bodyBackground(theme)) : [];
	});
}

/** `shell_job logs`, and the job it addressed by title where this session knows it. */
export function jobCallSegs(args: unknown, titleOf: (id: string) => string | null = () => null): Seg[] {
	const record = (args ?? {}) as { op?: unknown; id?: unknown; offset?: unknown; tail?: unknown; bytes?: unknown; limit?: unknown };
	const op = typeof record.op === "string" ? sanitizeControl(record.op) : "";
	const id = typeof record.id === "string" ? sanitizeControl(record.id) : "";
	const extras: string[] = [];
	if (typeof record.offset === "number") extras.push(`offset ${record.offset}`);
	if (record.tail === true) extras.push("tail");
	if (typeof record.bytes === "number") extras.push(`${record.bytes} bytes`);
	if (typeof record.limit === "number") extras.push(`limit ${record.limit}`);
	const title = id ? titleOf(id) : null;
	const target: Seg[] = id ? [{ text: ` ${title ?? id}`, color: title === null ? "accent" : "text" }] : [];
	return [
		{ text: "shell_job", color: "accent", bold: true },
		{ text: op ? ` ${op}` : "", color: "text" },
		...target,
		...(extras.length > 0 ? [{ text: ` (${extras.join(", ")})`, color: "muted" }] : []),
	];
}

/** The shell_job row's band: still while it runs (it takes milliseconds), then its result's color. */
export function renderJobCall(args: unknown, theme: Theme, context?: RowContext, titleOf?: (id: string) => string | null, now: () => number = Date.now): Component {
	return new Lines((width) => {
		const done = context?.isPartial === false;
		const phase = done ? { kind: "done" as const, outcome: context?.isError ? "fail" as const : "ok" as const, sinceMs: Number.POSITIVE_INFINITY } : { kind: "queued" as const };
		const rail: Seg[] = done && context?.isError ? [{ text: "failed", color: "error" }] : [];
		return [renderBand(theme, paletteFrom(theme), { width, phase, segs: jobCallSegs(args, titleOf), rail, clockMs: now() })];
	});
}

/** Result body for `shell_job`, collapsed to the tail like bash output. */
export function renderJobResult(result: unknown, options: { expanded: boolean }, theme: Theme): Component {
	const text = textOf((result as { content?: unknown } | null)?.content);
	const paint = painter(theme);
	return new Lines((width) => onBackground(bodyLines(text, paint, width, options.expanded), width, bodyBackground(theme)));
}

/**
 * Renderer for `shell-job-complete` messages: the job's band in its final
 * color, `finished` after its name, how it ended and how long it took on the
 * right. The command, log and output stay hidden until the message is
 * clicked (or everything is expanded), since the band already answers
 * whether it worked.
 *
 * Expansion is tracked per message because the interactive mode owns the
 * global expand flag; toggling that flag (ctrl+O) clears the per-message
 * choice so the global one keeps winning.
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
		const facts = completionFacts(view, message.details);
		// A message with no title or command names itself: "Job j1 finished: exit 0".
		const extra: Seg[] = facts.title === view.title ? [] : [{ text: " finished", color: "muted" }];
		const lines = new Lines((width) => {
			const band = jobBand(theme, facts, { width, now: 0, view: "calm", extra });
			if (!isExpanded()) return [band];
			const pad = " ".repeat(BODY_INDENT);
			const inner = Math.max(1, width - BODY_INDENT);
			const under = [...(view.command.length > 0 ? [`$ ${view.command}`] : []), ...view.meta].map((line) => pad + truncateToWidth(paint.fg("muted", line), inner, "\u2026"));
			const notice = view.notice.length > 0 ? [pad + truncateToWidth(paint.fg("warning", view.notice), inner, "\u2026")] : [];
			return [band, ...onBackground([...under, ...bodyLines(view.body, paint, width, true), ...notice], width, bodyBackground(theme))];
		});
		return {
			render: (width: number) => lines.render(width),
			invalidate: () => {},
			handleMouse: (event: { type: string; button: string }) => {
				if (event.type !== "click" || event.button !== "left") return undefined;
				overrides.set(key, !isExpanded());
				return { handled: true };
			},
		} as Component;
	};
}

/** The band facts of a completion, from the details the message was sent with. */
export function completionFacts(view: CompletionView, details: unknown): JobFacts {
	const record = (details ?? {}) as { code?: unknown; signal?: unknown; durationMs?: unknown; command?: unknown; title?: unknown };
	const durationMs = typeof record.durationMs === "number" ? record.durationMs : undefined;
	return {
		title: view.label.length > 0 ? view.label : view.command.length > 0 ? null : view.title,
		command: view.command,
		state: "done",
		code: typeof record.code === "number" ? record.code : null,
		signal: typeof record.signal === "string" ? record.signal : null,
		...(durationMs === undefined ? {} : { startedAt: 0, endedAt: durationMs }),
	};
}
