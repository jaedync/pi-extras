/**
 * The computer_use tool row. The call shows the script as highlighted code
 * rather than an escaped JSON string; the result is a timeline of the Computer
 * Use calls it made, each with its target, time and any approval, followed by
 * what the script emitted. Only `content` reaches the model; `details` is for
 * this row.
 */
import { Text, type Component } from "@earendil-works/pi-tui";
import type { CallRecord, Progress } from "./executor.ts";
import { formatMs } from "./describe.ts";
import type { Paint, PaintKey } from "./paint.ts";

const PREVIEW_CODE_LINES = 6;
const PREVIEW_TEXT_LINES = 5;
const MAX_EXPANDED_LINES = 1000;
/** Escape sequences in agent code or app text must not reach the terminal. */
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g;


export interface RowDetails {
	readonly calls?: CallRecord[];
	readonly running?: Progress["running"];
	readonly durationMs?: number;
}

interface CallOptions {
	readonly expanded: boolean;
	readonly paint: Paint;
	readonly highlight: (code: string) => string[];
	readonly hint: string;
}

interface ResultOptions {
	readonly expanded: boolean;
	readonly isError: boolean;
	readonly paint: Paint;
	readonly hint: string;
	readonly partial?: boolean;
	/** The last streamed details, for a failed run whose final result has none. */
	readonly last?: RowDetails;
}

const sanitize = (text: string) => text.replace(/\r/g, "").replace(/\t/g, "  ").replace(CONTROL, " ");
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

function more(hidden: number, options: { paint: Paint; hint: string }): string {
	return `${options.paint.fg("muted", `… ${plural(hidden, "more line")} (`)}${options.hint}${options.paint.fg("muted", ")")}`;
}

export function callLines(args: unknown, options: CallOptions): string[] {
	const { paint } = options;
	const title = paint.fg("toolTitle", paint.bold("computer_use"));
	const code = args && typeof args === "object" && typeof (args as { code?: unknown }).code === "string" ? sanitize((args as { code: string }).code).trimEnd() : "";
	if (!code) return [`${title} ${paint.fg("dim", "…")}`];
	const lines = options.highlight(code);
	const count = code.split("\n").length;
	const shown = options.expanded ? lines.slice(0, MAX_EXPANDED_LINES) : lines.slice(0, PREVIEW_CODE_LINES);
	const out = [count > 1 ? `${title} ${paint.fg("muted", plural(count, "line"))}` : title, ...shown.map((line) => `  ${line}`)];
	if (count > shown.length) out.push(`  ${more(count - shown.length, options)}`);
	return out;
}

function approvalNote(call: CallRecord): { text: string; key: PaintKey } | undefined {
	if (call.approval === "always") return { text: "always allowed", key: "success" };
	if (call.approval === "once") return { text: "allowed for this session", key: "success" };
	if (call.approval === "auto") return { text: "allowed by Allow all", key: "warning" };
	// The client's own denial message only repeats this.
	if (call.approval === "deny") return { text: "not allowed", key: "warning" };
	return undefined;
}

function timeline(details: RowDetails, paint: Paint): string[] {
	const calls = details.calls ?? [];
	const rows = [...calls.map((call) => ({ call, running: false })), ...(details.running ? [{ call: { ...details.running, ms: 0, ok: true } as CallRecord, running: true }] : [])];
	if (rows.length === 0) return [];
	const target = (call: Pick<CallRecord, "app" | "detail">) => [call.app, call.detail].filter(Boolean).join(" ");
	const methodWidth = Math.max(...rows.map(({ call }) => call.method.length));
	const targetWidth = Math.max(...rows.map(({ call }) => target(call).length));
	const msWidth = Math.max(0, ...calls.map((call) => formatMs(call.ms).length));
	return rows.map(({ call, running }) => {
		const mark = running ? paint.fg("muted", "…") : call.ok ? paint.fg("success", "✓") : paint.fg("error", "✗");
		const head = `${mark} ${paint.fg("toolOutput", call.method.padEnd(methodWidth))} ${paint.fg("accent", call.app ?? "")}${call.app && call.detail ? " " : ""}${paint.fg("muted", call.detail)}`;
		if (running) return head;
		const pad = " ".repeat(targetWidth - target(call).length);
		const notes: string[] = [];
		if (call.startupMs !== undefined) notes.push(paint.fg("dim", `started client ${formatMs(call.startupMs)}`));
		const approval = approvalNote(call);
		if (approval) notes.push(paint.fg(approval.key, approval.text));
		if (!call.ok && call.approval !== "deny" && call.error) notes.push(paint.fg("error", sanitize(call.error).split("\n")[0]));
		return `${head}${pad} ${paint.fg("dim", formatMs(call.ms).padStart(msWidth))}${notes.length ? `  ${notes.join(paint.fg("dim", ", "))}` : ""}`;
	});
}

function textOf(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content.flatMap((block) => block && block.type === "text" && typeof block.text === "string" ? [block.text] : []).join("\n");
}

function images(content: unknown): number {
	return Array.isArray(content) ? content.filter((block) => block && block.type === "image").length : 0;
}

function hasCalls(details: unknown): details is RowDetails {
	return !!details && typeof details === "object" && Array.isArray((details as RowDetails).calls);
}

export function resultLines(input: { content?: unknown; details?: unknown }, options: ResultOptions): string[] {
	const { paint } = options;
	const text = sanitize(textOf(input.content)).trimEnd();
	const textLines = text ? text.split("\n") : [];
	const shownText = options.expanded ? textLines.slice(0, MAX_EXPANDED_LINES) : textLines.slice(0, PREVIEW_TEXT_LINES);
	const body = shownText.map((line) => paint.fg(options.isError ? "error" : "toolOutput", line));
	if (textLines.length > shownText.length) body.push(more(textLines.length - shownText.length, options));

	const details = hasCalls(input.details) ? input.details : options.isError ? options.last : undefined;
	const calls = details?.calls ?? [];
	// 0.4.0 stored only the method names.
	if (calls.some((call) => typeof call === "string")) return [paint.fg("muted", (calls as unknown as string[]).join(", ")), ...body];
	if (!details) return body;

	const out = [...timeline(details, paint), ...body];
	if (!options.partial && !options.isError && details.durationMs !== undefined) {
		const shots = images(input.content);
		out.push(paint.fg("muted", `${plural(calls.length, "call")} in ${formatMs(details.durationMs)}${shots ? `, ${plural(shots, "screenshot")}` : ""}`));
	}
	return out;
}

export function renderCall(args: unknown, options: CallOptions): Component {
	return new Text(callLines(args, options).join("\n"), 0, 0);
}

export function renderResult(input: { content?: unknown; details?: unknown }, options: ResultOptions): Component {
	const lines = resultLines(input, options);
	return new Text(lines.length ? `\n${lines.join("\n")}` : "", 0, 0);
}
