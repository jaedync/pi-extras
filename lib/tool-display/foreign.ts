/**
 * The row of another extension's tool, drawn with the band. The band names
 * the tool and what it was called with, and says how the call ended and how
 * long it took. Under it sit the first lines of the tool's own result, and
 * the popup has every argument and the whole result.
 *
 * The tool's own renderers still draw what they know best: the call line
 * they would show becomes the band's text, and their result is the body.
 * When a renderer is missing or throws, the row falls back to the arguments
 * and the result's text.
 */
import { stripTerminalSequences, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import type { Seg } from "../band/band.ts";
import { sanitize } from "./format.ts";
import { errorLines, more, plural, resultText, textLines, titleSeg, wrapAll } from "./kit.ts";
import { toolRenderers, type ToolSpec, type View } from "./tool.ts";
import type { Kit } from "./kit.ts";

/** Result lines shown under the band before `… N more lines`. */
export const FOREIGN_PREVIEW_LINES = 4;
/**
 * A running call's band redraws every frame. The tool's own renderers are
 * asked again when Pi has something new for them, and otherwise this often
 * at most, in case the tool changed its result in place.
 */
export const BORROWED_REFRESH_MS = 250;
/** Wide enough that a tool's call line is never wrapped before its first line is taken. */
const CALL_WIDTH = 400;
/** Arguments that say what a call is about, most telling first. */
const KEY_ARGS = ["query", "url", "urls", "path", "command", "task", "prompt", "message", "objective", "tool", "name", "id", "action", "code"];

type Render = (...args: unknown[]) => Component;

export interface ForeignTool {
	readonly name: string;
	readonly label?: string;
	readonly renderCall?: Render;
	readonly renderResult?: Render;
}

interface Memo<T> {
	readonly key: readonly unknown[];
	readonly at: number;
	readonly value: T;
}

interface Borrowed {
	/** The tool's own renderer state, apart from the row's. */
	readonly state: Record<string, unknown>;
	call?: Component;
	result?: Component;
	words?: Memo<string | undefined>;
	lines?: Memo<string[]>;
	expandedLines?: Memo<string[]>;
}

const flat = (text: string) => sanitize(stripTerminalSequences(text)).replace(/\s+/g, " ").trim();
const failed = (view: View) => !view.context.isPartial && view.context.isError;

function borrowed(view: View): Borrowed {
	return (view.row.borrowed ??= { state: {} }) as Borrowed;
}

/** The kept value while `key` is unchanged, and for a running call not yet BORROWED_REFRESH_MS old; else a new one. */
function remember<T>(view: View, memo: Memo<T> | undefined, key: readonly unknown[], compute: () => T): Memo<T> {
	const same = memo !== undefined && memo.key.length === key.length && memo.key.every((part, index) => Object.is(part, key[index]));
	if (same && (!view.context.isPartial || view.now - memo.at < BORROWED_REFRESH_MS)) return memo;
	return { key, at: view.now, value: compute() };
}

/** The tool's renderer, called the way Pi would, with its own state and last component. */
function contextFor(view: View, own: Borrowed, last: Component | undefined, over: Record<string, unknown> = {}) {
	return { ...view.context, state: own.state, lastComponent: last, ...over };
}

function drawn(component: Component | undefined, width: number): string[] {
	if (!component) return [];
	const lines = component.render(width);
	let start = 0;
	let end = lines.length;
	while (start < end && flat(lines[start]!) === "") start++;
	while (end > start && flat(lines[end - 1]!) === "") end--;
	return lines.slice(start, end);
}

/** A short name a tool gives itself, `get_content` for get_search_content: every word of it is in the tool's name. */
function nicknameOf(tool: ForeignTool, word: string): boolean {
	const parts = new Set(tool.name.toLowerCase().split(/[_\s-]+/));
	return word.split(/[_-]+/).every((part) => part !== "" && parts.has(part.toLowerCase()));
}

/** The tool's call line as plain words, without the tool's name when it leads. */
function callWords(tool: ForeignTool, view: View): string | undefined {
	const render = tool.renderCall;
	if (!render) return undefined;
	const own = borrowed(view);
	const { args, isPartial, isError, executionStarted, argsComplete } = view.context;
	own.words = remember(view, own.words, [args, isPartial, isError, executionStarted, argsComplete], () => drawnWords(tool, render, view, own));
	return own.words.value;
}

function drawnWords(tool: ForeignTool, render: Render, view: View, own: Borrowed): string | undefined {
	try {
		own.call = render(view.context.args, view.theme, contextFor(view, own, own.call));
	} catch {
		own.call = undefined;
		return undefined;
	}
	const first = drawn(own.call, CALL_WIDTH).map(flat).find((line) => line !== "");
	if (!first) return undefined;
	let words = first;
	for (const lead of [tool.name, tool.label]) {
		if (lead && words.toLowerCase().startsWith(lead.toLowerCase())) words = words.slice(lead.length).replace(/^[\s:·—-]+/, "");
	}
	const [head = "", ...rest] = words.split(" ");
	if (rest.length > 0 && nicknameOf(tool, head)) words = rest.join(" ");
	return words === "" ? undefined : words;
}

function argText(value: unknown): string | undefined {
	if (typeof value === "string") return flat(value.split("\n").find((line) => line.trim() !== "") ?? "");
	if (Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string")) {
		return `${flat(value[0] as string)}${value.length > 1 ? ` +${value.length - 1}` : ""}`;
	}
	return undefined;
}

/** The one argument that says what the call is about. */
export function keyArg(args: unknown): string | undefined {
	if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
	const record = args as Record<string, unknown>;
	for (const key of KEY_ARGS) {
		const text = argText(record[key]);
		if (text) return text;
	}
	for (const value of Object.values(record)) {
		const text = argText(value);
		if (text) return text;
	}
	return undefined;
}

/** A result drawn as the call again with a hint after it, as pi-mcp-adapter's compact rows are: the band already says it. */
function restatesCall(tool: ForeignTool, lines: readonly string[]): boolean {
	const first = lines.length <= 2 ? flat(lines[0] ?? "").toLowerCase() : "";
	return first.startsWith(`${tool.name.toLowerCase()} `);
}

function resultLines(tool: ForeignTool, view: View, width: number, expanded: boolean): string[] {
	const own = borrowed(view);
	const { isPartial, isError } = view.context;
	const key = [view.result?.content, view.result?.details, isPartial, isError, width];
	if (expanded) own.expandedLines = remember(view, own.expandedLines, key, () => drawnResult(tool, view, own, width, true));
	else own.lines = remember(view, own.lines, key, () => drawnResult(tool, view, own, width, false));
	return (expanded ? own.expandedLines : own.lines)!.value;
}

function drawnResult(tool: ForeignTool, view: View, own: Borrowed, width: number, expanded: boolean): string[] {
	if (!view.result) return [];
	if (failed(view)) return wrapAll(errorLines(view.paint, resultText(view.result)), width);
	if (tool.renderResult) {
		try {
			const options = { expanded, isPartial: view.context.isPartial };
			const last = expanded ? undefined : own.result;
			const component = tool.renderResult(view.result, options, view.theme, contextFor(view, own, last, { expanded }));
			if (!expanded) own.result = component;
			const lines = drawn(component, width);
			if (!restatesCall(tool, lines)) return lines;
		} catch {
			// Fall back to the result's text.
		}
	}
	return wrapAll(textLines(resultText(view.result)).map((line) => view.paint.fg("toolOutput", line)), width);
}

/** Every argument, one per line: strings as written, anything else as JSON. */
function argumentLines(view: View, width: number): string[] {
	const args = view.context.args;
	if (!args || typeof args !== "object" || Array.isArray(args)) return [];
	const entries = Object.entries(args as Record<string, unknown>);
	const keyWidth = Math.max(0, ...entries.map(([key]) => key.length));
	return entries.flatMap(([key, value]) => {
		const text = typeof value === "string" ? sanitize(stripTerminalSequences(value)) : JSON.stringify(value, null, 2) ?? String(value);
		const [first = "", ...rest] = text.replace(/\n+$/, "").split("\n");
		const pad = " ".repeat(keyWidth + 2);
		return wrapAll([
			`${view.paint.fg("muted", key.padEnd(keyWidth))}  ${view.paint.fg("toolOutput", first)}`,
			...rest.map((line) => `${pad}${view.paint.fg("toolOutput", line)}`),
		], width);
	});
}

export function foreignSpec(tool: ForeignTool): ToolSpec {
	return {
		label: () => tool.name,
		title(view) {
			const words = callWords(tool, view) ?? keyArg(view.context.args);
			return [titleSeg(tool.name), ...(words ? [{ text: ` ${words}`, color: "toolOutput" } satisfies Seg] : [])];
		},
		body(view, width) {
			const lines = resultLines(tool, view, width, view.context.expanded);
			if (view.context.expanded || lines.length <= FOREIGN_PREVIEW_LINES) return lines;
			const hidden = lines.length - FOREIGN_PREVIEW_LINES;
			return [...lines.slice(0, FOREIGN_PREVIEW_LINES), truncateToWidth(more(view.paint, view.kit, plural(hidden, "more line")), width, "…")];
		},
		details: () => (tool.label && tool.label !== tool.name ? tool.label : ""),
		head: (view, width) => argumentLines(view, width),
		output(view, width) {
			const lines = resultLines(tool, view, width, true);
			if (lines.length > 0) return lines;
			return [view.paint.fg("dim", view.context.isPartial ? "(no output yet)" : "(no output)")];
		},
	};
}

export const foreignRenderers = (kit: Kit, tool: ForeignTool) => toolRenderers(kit, foreignSpec(tool));
