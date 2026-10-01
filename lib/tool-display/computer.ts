/**
 * The computer_use row, and windows_use's, which shares it. The band names the
 * apps (or VMs) the script used and how many calls it made; under it sit the
 * last calls, each with its target and time, then the start of what the script
 * emitted. The popup has the script, highlighted, and every call and line of
 * output.
 */
import { SEP } from "../cc-phase.ts";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { Seg } from "../band/band.ts";
import { formatMs } from "../computer-use/describe.ts";
import type { CallRecord, Progress } from "../computer-use/executor.ts";
import { sanitize } from "./format.ts";
import { codeLines, hasImage, head, more, mutedSeg, plural, resultText, stringArg, textLines, titleSeg, wrapAll, type Paint } from "./kit.ts";
import type { ToolSpec, View } from "./tool.ts";

/** Calls listed under the band; earlier ones fold into `… N earlier calls`. */
export const CALL_PREVIEW_LINES = 4;
/** Lines of emitted text under the calls. */
export const EMIT_PREVIEW_LINES = 3;

interface RowDetails {
	readonly calls?: readonly CallRecord[];
	readonly running?: Progress["running"];
	readonly durationMs?: number;
}

const flat = (text: string) => sanitize(text).replace(/\s+/g, " ").trim();
const failed = (view: View) => !view.context.isPartial && view.context.isError;
const hasCalls = (details: unknown): details is RowDetails =>
	!!details && typeof details === "object" && Array.isArray((details as RowDetails).calls) && (details as RowDetails).calls!.every((call) => typeof call === "object");

/** The latest calls: a thrown error arrives without details, so the last streamed ones stand in. */
function detailsOf(view: View): RowDetails | undefined {
	const details = view.result?.details;
	if (hasCalls(details)) {
		view.row.lastCalls = details;
		return details;
	}
	return view.row.lastCalls as RowDetails | undefined;
}

function codeOf(view: View): string {
	return sanitize(stringArg(view.context.args, "code") ?? "").trimEnd();
}

function apps(calls: readonly CallRecord[]): string[] {
	return [...new Set(calls.flatMap((call) => (call.app ? [flat(call.app)] : [])))];
}

function summary(view: View, details: RowDetails): Seg[] {
	const calls = details.calls ?? [];
	if (view.context.isPartial || calls.length === 0) return [];
	const shots = view.result && hasImage(view.result) ? (view.result.content as { type?: string }[]).filter((block) => block?.type === "image").length : 0;
	return [mutedSeg(`${SEP}${plural(calls.length, "call")}${shots > 0 ? `${SEP}${plural(shots, "screenshot")}` : ""}`)];
}

function approvalNote(paint: Paint, call: CallRecord): string | undefined {
	if (call.approval === "always") return paint.fg("muted", "always allowed");
	if (call.approval === "once") return paint.fg("muted", "allowed for this session");
	if (call.approval === "auto") return paint.fg("warning", "allowed by Allow all");
	return undefined;
}

/** How a script tool names itself, its calls and the process a cold call starts. */
export interface ScriptRowNames {
	readonly title: string;
	readonly call: string;
	readonly started: string;
}

function callLine(paint: Paint, names: ScriptRowNames, call: CallRecord, methodWidth: number, running: boolean): string {
	const target = [call.app ? paint.fg("accent", flat(call.app)) : "", call.detail ? paint.fg("muted", flat(call.detail)) : ""].filter(Boolean).join(" ");
	const head = `${paint.fg("toolOutput", call.method.padEnd(methodWidth))}  ${target}`;
	if (running) return `${head}  ${paint.fg("dim", "…")}`;
	const notes = [paint.fg("dim", formatMs(call.ms))];
	if (call.startupMs !== undefined) notes.push(paint.fg("dim", `started ${names.started} ${formatMs(call.startupMs)}`));
	const approval = approvalNote(paint, call);
	if (approval) notes.push(approval);
	if (call.approval === "deny") notes.push(paint.fg("warning", "not allowed"));
	else if (!call.ok) notes.push(paint.fg("error", `failed${call.error ? `: ${flat(call.error.split("\n")[0] ?? "")}` : ""}`));
	return `${head}  ${notes.join(paint.fg("dim", SEP))}`;
}

function timeline(paint: Paint, names: ScriptRowNames, details: RowDetails): string[] {
	const calls = details.calls ?? [];
	const all = [...calls.map((call) => ({ call, running: false })), ...(details.running ? [{ call: { ...details.running, ms: 0, ok: true } as CallRecord, running: true }] : [])];
	const methodWidth = Math.max(0, ...all.map(({ call }) => call.method.length));
	return all.map(({ call, running }) => callLine(paint, names, call, methodWidth, running));
}

function emitted(view: View): string[] {
	return textLines(resultText(view.result)).map((line) => view.paint.fg(failed(view) ? "error" : "toolOutput", line));
}

export const scriptSpec = (names: ScriptRowNames): ToolSpec => ({
	name: names.title,
	label: () => names.title,
	title(view) {
		const details = detailsOf(view);
		const used = apps(details?.calls ?? (details?.running ? [details.running as CallRecord] : []));
		if (used.length > 0) return [titleSeg(names.title), { text: ` ${used.join(", ")}`, color: "accent" }, ...summary(view, details!)];
		const first = codeOf(view).split("\n").find((line) => line.trim() !== "");
		return [titleSeg(names.title), ...(first ? [{ text: ` ${flat(first)}`, color: "toolOutput" }] : [])];
	},
	body(view, width) {
		const details = detailsOf(view);
		const calls = details ? timeline(view.paint, names, details) : [];
		const text = view.context.isPartial ? [] : emitted(view);
		if (view.context.expanded) return wrapAll([...calls, ...text], width);
		// One call more shows in the row a hint for it would take.
		const hidden = calls.length > CALL_PREVIEW_LINES + 1 ? calls.length - CALL_PREVIEW_LINES : 0;
		const shownCalls = [
			...(hidden > 0 ? [more(view.paint, view.kit, plural(hidden, "earlier call"))] : []),
			...calls.slice(hidden),
		].map((line) => truncateToWidth(line, width, "…"));
		const shownText = head(wrapAll(text, width), EMIT_PREVIEW_LINES, (extra) => truncateToWidth(more(view.paint, view.kit, plural(extra, "more line")), width, "…"));
		return [...shownCalls, ...shownText];
	},
	details(view) {
		const details = detailsOf(view);
		const calls = details?.calls?.length ?? 0;
		const took = details?.durationMs;
		return [plural(calls, names.call), ...(typeof took === "number" ? [`took ${formatMs(took)}`] : [])].join(SEP);
	},
	head(view, width) {
		const code = codeOf(view);
		return code ? wrapAll(codeLines(view.paint, view.kit, code.split("\n"), "javascript"), width) : [];
	},
	output(view, width) {
		const details = detailsOf(view);
		const calls = details ? timeline(view.paint, names, details) : [];
		const text = view.context.isPartial ? [] : emitted(view);
		const lines = [...calls, ...(calls.length > 0 && text.length > 0 ? [""] : []), ...text];
		return lines.length > 0 ? wrapAll(lines, width) : [view.paint.fg("dim", view.context.isPartial ? "(no calls yet)" : "(no output)")];
	},
});

export const computerUseSpec = scriptSpec({ title: "computer_use", call: "Computer Use call", started: "client" });
export const windowsUseSpec = scriptSpec({ title: "windows_use", call: "Windows call", started: "host" });
