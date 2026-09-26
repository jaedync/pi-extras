/**
 * The computer_use row. The band names the apps the script used and how many
 * Computer Use calls it made; under it sit the last calls, each with its
 * target and time, then the start of what the script emitted. The popup has
 * the script, highlighted, and every call and line of output.
 */
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { Seg } from "../band/band.ts";
import { formatMs } from "../computer-use/describe.ts";
import type { CallRecord, Progress } from "../computer-use/executor.ts";
import { sanitize } from "./format.ts";
import { codeLines, hasImage, more, mutedSeg, plural, resultText, stringArg, textLines, titleSeg, wrapAll, type Paint } from "./kit.ts";
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
	return [mutedSeg(` · ${plural(calls.length, "call")}${shots > 0 ? ` · ${plural(shots, "screenshot")}` : ""}`)];
}

function approvalNote(paint: Paint, call: CallRecord): string | undefined {
	if (call.approval === "always") return paint.fg("muted", "always allowed");
	if (call.approval === "once") return paint.fg("muted", "allowed for this session");
	if (call.approval === "auto") return paint.fg("warning", "allowed by Allow all");
	return undefined;
}

function callLine(paint: Paint, call: CallRecord, methodWidth: number, running: boolean): string {
	const target = [call.app ? paint.fg("accent", flat(call.app)) : "", call.detail ? paint.fg("muted", flat(call.detail)) : ""].filter(Boolean).join(" ");
	const head = `${paint.fg("toolOutput", call.method.padEnd(methodWidth))}  ${target}`;
	if (running) return `${head}  ${paint.fg("dim", "…")}`;
	const notes = [paint.fg("dim", formatMs(call.ms))];
	if (call.startupMs !== undefined) notes.push(paint.fg("dim", `started client ${formatMs(call.startupMs)}`));
	const approval = approvalNote(paint, call);
	if (approval) notes.push(approval);
	if (call.approval === "deny") notes.push(paint.fg("warning", "not allowed"));
	else if (!call.ok) notes.push(paint.fg("error", `failed${call.error ? `: ${flat(call.error.split("\n")[0] ?? "")}` : ""}`));
	return `${head}  ${notes.join(paint.fg("dim", " · "))}`;
}

function timeline(paint: Paint, details: RowDetails): string[] {
	const calls = details.calls ?? [];
	const all = [...calls.map((call) => ({ call, running: false })), ...(details.running ? [{ call: { ...details.running, ms: 0, ok: true } as CallRecord, running: true }] : [])];
	const methodWidth = Math.max(0, ...all.map(({ call }) => call.method.length));
	return all.map(({ call, running }) => callLine(paint, call, methodWidth, running));
}

function emitted(view: View): string[] {
	return textLines(resultText(view.result)).map((line) => view.paint.fg(failed(view) ? "error" : "toolOutput", line));
}

export const computerUseSpec: ToolSpec = {
	label: () => "computer_use",
	title(view) {
		const details = detailsOf(view);
		const used = apps(details?.calls ?? (details?.running ? [details.running as CallRecord] : []));
		if (used.length > 0) return [titleSeg("computer_use"), { text: ` ${used.join(", ")}`, color: "accent" }, ...summary(view, details!)];
		const first = codeOf(view).split("\n").find((line) => line.trim() !== "");
		return [titleSeg("computer_use"), ...(first ? [{ text: ` ${flat(first)}`, color: "toolOutput" }] : [])];
	},
	body(view, width) {
		const details = detailsOf(view);
		const calls = details ? timeline(view.paint, details) : [];
		const text = view.context.isPartial ? [] : emitted(view);
		if (view.context.expanded) return wrapAll([...calls, ...text], width);
		const hidden = Math.max(0, calls.length - CALL_PREVIEW_LINES);
		const shownCalls = [
			...(hidden > 0 ? [more(view.paint, view.kit, plural(hidden, "earlier call"))] : []),
			...calls.slice(hidden),
		].map((line) => truncateToWidth(line, width, "…"));
		const shownText = wrapAll(text, width);
		const extra = shownText.length - EMIT_PREVIEW_LINES;
		return [
			...shownCalls,
			...shownText.slice(0, EMIT_PREVIEW_LINES),
			...(extra > 0 ? [truncateToWidth(more(view.paint, view.kit, plural(extra, "more line")), width, "…")] : []),
		];
	},
	details(view) {
		const details = detailsOf(view);
		const calls = details?.calls?.length ?? 0;
		const took = details?.durationMs;
		return [plural(calls, "Computer Use call"), ...(typeof took === "number" ? [`took ${formatMs(took)}`] : [])].join(" · ");
	},
	head(view, width) {
		const code = codeOf(view);
		return code ? wrapAll(codeLines(view.paint, view.kit, code.split("\n"), "javascript"), width) : [];
	},
	output(view, width) {
		const details = detailsOf(view);
		const calls = details ? timeline(view.paint, details) : [];
		const text = view.context.isPartial ? [] : emitted(view);
		const lines = [...calls, ...(calls.length > 0 && text.length > 0 ? [""] : []), ...text];
		return lines.length > 0 ? wrapAll(lines, width) : [view.paint.fg("dim", view.context.isPartial ? "(no calls yet)" : "(no output)")];
	},
};
