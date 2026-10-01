/** JavaScript is not a shell chain. Only observed calls receive numbered execution cells. */
import { stripVTControlCharacters } from "node:util";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { timeSeg, type Seg } from "../band/band.ts";
import type { SheetCopy } from "../band/sheet.ts";
import { foreignSpec, type ForeignTool } from "./foreign.ts";
import { codeLines, more, plural, resultText, stringArg, wrapAll, type Kit } from "./kit.ts";
import { NESTED_CALL_LIMIT, OMITTED_OUTPUT, readCalls, type CallSnapshot, type NestedCall } from "./nested.ts";
import { BODY_INDENT } from "./row.ts";
import { digitsOf, numberedLine, numberLabel, type ShownState } from "./steps.ts";
import { toolRenderers, type ToolSpec, type View } from "./tool.ts";
import { sanitize } from "./format.ts";

export const CODEMODE_CALL_PREVIEW = 4;
const STATES: Record<NestedCall["status"], ShownState> = { running: "running", ok: "ok", error: "fail", cancelled: "aborted", unfinished: "unknown" };
const WORDS = { running: "running", ok: "done", error: "failed", cancelled: "aborted", unfinished: "unfinished" } as const;
const flat = (text: string) => text.replace(/\s+/g, " ").trim();
const rawCodeOf = (view: View) => stringArg(view.context.args, "code", "script", "source");
const codeOf = (view: View) => sanitize(rawCodeOf(view) ?? "").trimEnd();
const SCRIPT_PREVIEW_LINES = 4;
const SCRIPT_PREVIEW_CHARS = 2_048;
const writingSource = (view: View) => view.context.isPartial && !view.context.argsComplete && !view.context.executionStarted;
const SOURCE_VIEW = 0;
const RESULT_VIEW = 1;
const CALL_VIEW_OFFSET = 2;
const CLIPBOARD_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
const CLIPBOARD_C1 = /[\u0080-\u009f]/g;
const CLIPBOARD_STRING_SEQUENCE = /\x1b[P\]X^_][\s\S]*?(?:\x07|\x1b\\|$)/g;

function clipboardCodeOf(view: View): string | undefined {
	const code = rawCodeOf(view);
	if (code === undefined) return undefined;
	// Bare C1 bytes also occur in mojibake. They must not swallow the remaining source.
	const plain = code.replace(CLIPBOARD_C1, "");
	// Older Pi's CSI stripper can consume ordinary source after a bracketed-paste marker.
	return stripVTControlCharacters(plain.replace(CLIPBOARD_STRING_SEQUENCE, "")).replace(CLIPBOARD_CONTROL, "");
}

function callsOf(view: View): CallSnapshot | undefined {
	const snapshot = snapshotOf(view);
	if (!snapshot || view.context.isPartial || !snapshot.calls.some((call) => call.status === "running")) return snapshot;
	return { complete: false, calls: snapshot.calls.map((call) => call.status === "running" ? { ...call, status: "unfinished" as const } : call) };
}

function snapshotOf(view: View): CallSnapshot | undefined {
	const observed = view.kit.nestedCalls?.(view.context.toolCallId);
	const saved = readCalls((view.result as { nestedCalls?: unknown } | undefined)?.nestedCalls);
	if (observed) {
		const details = readCalls(view.result?.details);
		// Reversing keeps the first duplicate detail authoritative, like the former find().
		const detailById = new Map((details?.calls ?? []).toReversed().map((call) => [call.id, call]));
		const observedIds = new Set(observed.calls.map((call) => call.id));
		const calls = observed.calls.map((call) => {
			const detail = detailById.get(call.id);
			return detail ? { ...detail, ...call, status: detail.status === "cancelled" ? "cancelled" as const : call.status } : call;
		});
		const extra = details?.calls.filter((call) => !call.id.endsWith("/?") && !observedIds.has(call.id)) ?? [];
		return { complete: observed.complete && saved?.complete !== false && details?.complete !== false && calls.length + extra.length <= NESTED_CALL_LIMIT, calls: [...calls, ...extra].slice(0, NESTED_CALL_LIMIT) };
	}
	const details = readCalls(view.result?.details);
	const snapshot = saved ?? details;
	if (snapshot) view.row.nested = snapshot;
	return snapshot ?? view.row.nested as CallSnapshot | undefined;
}

function stepKeys(view: View): readonly string[] {
	const occurrences = new Map<string, number>();
	const keys = (callsOf(view)?.calls ?? []).map((call) => {
		const occurrence = occurrences.get(call.id) ?? 0;
		occurrences.set(call.id, occurrence + 1);
		return `codemode:call:${JSON.stringify([call.id, occurrence])}`;
	});
	return ["codemode:source", "codemode:result", ...keys];
}

function callLine(view: View, call: NestedCall, index: number, width: number, indent: number, digits: number): string {
	const ms = call.status === "running" && call.startedAt !== undefined ? view.now - call.startedAt : call.durationMs;
	const color = call.status === "error" ? "error" : call.status === "ok" ? "muted" : "dim";
	const rail: Seg[] = [
		...(call.overlapping ? [{ text: "overlap  ", color: "dim" }] : []),
		{ text: WORDS[call.status], color }, ...(ms === undefined ? [] : [{ text: "  ", color: "dim" }, timeSeg(ms)]),
	];
	const label = numberLabel(index + 1, digits, "ƒ");
	return numberedLine(view.theme, indent > 0 ? label.slice(1) : label, [
		{ text: flat(call.name), color: "text", bold: true }, ...(call.args ? [{ text: ` ${flat(call.args)}`, color: "muted" }] : []),
	], rail, STATES[call.status], width, { indent, now: view.now, motion: view.kit.motion() });
}

function timeline(view: View, width: number): string[] {
	const snapshot = callsOf(view);
	if (!snapshot) return [];
	const hidden = view.context.expanded ? 0 : Math.max(0, snapshot.calls.length - CODEMODE_CALL_PREVIEW);
	const hint = hidden > 0 ? [" ".repeat(BODY_INDENT) + more(view.paint, view.kit, plural(hidden, "earlier call"))] : [];
	// Width comes from every call, not just those shown, so expanding keeps each number's cell.
	const digits = digitsOf(snapshot.calls.length);
	const lines = snapshot.calls.slice(hidden).map((call, index) => callLine(view, call, index + hidden, width, BODY_INDENT, digits));
	const incomplete = snapshot.complete ? [] : [" ".repeat(BODY_INDENT) + view.paint.fg("dim", "nested call record incomplete")];
	return [...hint, ...lines, ...incomplete].map((line) => truncateToWidth(line, width, "…"));
}

function callOutput(view: View, call: NestedCall, selected: number, width: number): string[] {
	const lines = [callLine(view, call, selected, width, 0, digitsOf(callsOf(view)?.calls.length ?? 1)), ...(call.args ? wrapAll([call.args], width) : [])];
	const output = call.output ?? call.error;
	return [...lines, ...wrapAll([output ?? (call.status === "running" ? "(no output yet)" : "(nested result not saved; see script result)")], width)];
}

function popupHead(view: View, width: number, selected: number): string[] {
	const calls = callsOf(view)?.calls ?? [];
	const callDigits = digitsOf(calls.length);
	const labels = ["script source", "script result", ...calls.map((call, index) => `${`ƒ${index + 1}`.padEnd(callDigits + 1)} ${flat(call.name)} · ${WORDS[call.status]}`)];
	const digits = digitsOf(labels.length);
	return labels.map((label, index) => {
		const text = `${String(index + 1).padStart(digits)} ${label}`;
		return truncateToWidth(view.paint.fg(index === selected ? "accent" : "muted", index === selected ? view.paint.bold(text) : text), width, "…");
	});
}

function sourceOutput(view: View, width: number, fallback: ToolSpec): string[] {
	const code = codeOf(view);
	const args = rawCodeOf(view) === undefined ? fallback.head?.(view, width, SOURCE_VIEW) ?? [] : [];
	const lines = code ? wrapAll(codeLines(view.paint, view.kit, code.split("\n"), "javascript"), width)
		: args.length ? args : [view.paint.fg("dim", "(no script source)")];
	return lines.map((line) => truncateToWidth(line, width, "…"));
}

function scriptPreview(view: View, width: number): string[] {
	// Pi already decodes incremental JSON arguments. Source text never implies execution.
	const source = sanitize(clipboardCodeOf(view) ?? "").trimEnd();
	const lines = source.slice(-SCRIPT_PREVIEW_CHARS).split("\n");
	const shown = source ? lines.slice(-SCRIPT_PREVIEW_LINES) : [];
	const available = Math.max(1, width - BODY_INDENT);
	const truncated = source.length > SCRIPT_PREVIEW_CHARS || lines.length > SCRIPT_PREVIEW_LINES || shown.some((line) => visibleWidth(line) > available);
	return [view.paint.fg("dim", "Writing JavaScript…"), ...codeLines(view.paint, view.kit, shown, "javascript"),
		...(truncated ? [view.paint.fg("dim", "… script preview truncated")] : [])]
		.map((line) => truncateToWidth(" ".repeat(BODY_INDENT) + line, width, "…"));
}

function retainedOutput(view: View, selected: number): string | undefined {
	const call = callsOf(view)?.calls[selected - CALL_VIEW_OFFSET];
	if (!call || call.output === OMITTED_OUTPUT) return undefined;
	const output = call.output ?? call.error;
	return output === undefined ? undefined : resultText({ content: [{ type: "text", text: output }] }) || undefined;
}

function popupCopies(view: View, selected: number): readonly SheetCopy[] {
	const script: SheetCopy = { label: "copy script", key: "c", text: () => clipboardCodeOf(view) };
	if (selected === SOURCE_VIEW) return [script];
	return [script, {
		label: selected === RESULT_VIEW ? "copy result" : "copy preview", key: "o",
		text: () => selected === RESULT_VIEW ? resultText(view.result) || undefined : retainedOutput(view, selected),
	}];
}

export function codemodeSpec(tool: ForeignTool): ToolSpec {
	const fallback = foreignSpec(tool);
	return {
		...fallback,
		label: () => "codemode · JavaScript tool calls",
		title(view) {
			const calls = callsOf(view)?.calls;
			return [{ text: "{} ", color: "accent", bold: true }, { text: "codemode · JavaScript", color: "text", bold: true },
				...(calls?.length ? [{ text: ` · ${plural(calls.length, "call")}`, color: "muted" }] : [])];
		},
		below(view, width) {
			if (writingSource(view)) return [...scriptPreview(view, width), ...timeline(view, width)];
			const code = view.context.expanded ? wrapAll(codeLines(view.paint, view.kit, codeOf(view).split("\n"), "javascript"), Math.max(1, width - BODY_INDENT)) : [];
			return [...code.map((line) => truncateToWidth(" ".repeat(BODY_INDENT) + line, width, "…")), ...timeline(view, width)];
		},
		body(view, width) {
			// A tool without event metadata keeps its own result vocabulary and renderer.
			if (!callsOf(view)) return fallback.body(view, width);
			const details = view.result?.details;
			const result = { ...view.result, details: details && typeof details === "object" ? { ...details, calls: [] } : details };
			return fallback.body({ ...view, result }, width);
		},
		details: (view) => callsOf(view)?.complete === false ? "JavaScript · nested call record incomplete" : "JavaScript · call elapsed includes queue and permission waits",
		head: popupHead,
		steps: (view) => (callsOf(view)?.calls.length ?? 0) + CALL_VIEW_OFFSET,
		firstStep: () => SOURCE_VIEW,
		stepKeys,
		outputLabel: (view, selected) => selected === SOURCE_VIEW ? "script source" : selected === RESULT_VIEW ? "script result"
			: `ƒ${selected - CALL_VIEW_OFFSET + 1} ${flat(callsOf(view)?.calls[selected - CALL_VIEW_OFFSET]?.name ?? "(not available)")}`,
		output(view, width, selected) {
			if (selected === SOURCE_VIEW) return sourceOutput(view, width, fallback);
			if (selected === RESULT_VIEW) return fallback.output(view, width, selected);
			const call = callsOf(view)?.calls[selected - CALL_VIEW_OFFSET];
			return call ? callOutput(view, call, selected - CALL_VIEW_OFFSET, width) : [view.paint.fg("dim", "(nested call not available)")];
		},
		copies: popupCopies,
	};
}

export function codemodeRenderers(kit: Kit, tool: ForeignTool) {
	const renderers = toolRenderers(kit, codemodeSpec(tool));
	return {
		...renderers,
		renderCall(...args: Parameters<typeof renderers.renderCall>) {
			kit.watchNested?.(args[2].toolCallId, () => args[2].invalidate());
			return renderers.renderCall(...args);
		},
	};
}
