/** JavaScript is not a shell chain. Only observed calls receive numbered execution cells. */
import { truncateToWidth } from "@earendil-works/pi-tui";
import { timeSeg, type Seg } from "../band/band.ts";
import { foreignSpec, type ForeignTool } from "./foreign.ts";
import { codeLines, more, plural, stringArg, wrapAll, type Kit } from "./kit.ts";
import { NESTED_CALL_LIMIT, readCalls, type CallSnapshot, type NestedCall } from "./nested.ts";
import { BODY_INDENT } from "./row.ts";
import { numberedLine, type ShownState } from "./steps.ts";
import { toolRenderers, type ToolSpec, type View } from "./tool.ts";
import { sanitize } from "./format.ts";

export const CODEMODE_CALL_PREVIEW = 4;
const STATES: Record<NestedCall["status"], ShownState> = { running: "running", ok: "ok", error: "fail", cancelled: "aborted", unfinished: "unknown" };
const WORDS = { running: "running", ok: "done", error: "failed", cancelled: "aborted", unfinished: "unfinished" } as const;
const flat = (text: string) => text.replace(/\s+/g, " ").trim();
const codeOf = (view: View) => sanitize(stringArg(view.context.args, "code", "script", "source") ?? "").trimEnd();

function callsOf(view: View): CallSnapshot | undefined {
	const snapshot = snapshotOf(view);
	if (!snapshot || view.context.isPartial || !snapshot.calls.some((call) => call.status === "running")) return snapshot;
	return { complete: false, calls: snapshot.calls.map((call) => call.status === "running" ? { ...call, status: "unfinished" as const } : call) };
}

function snapshotOf(view: View): CallSnapshot | undefined {
	const observed = view.kit.nestedCalls?.(view.context.toolCallId);
	if (observed) {
		const details = readCalls(view.result?.details);
		const calls = observed.calls.map((call) => {
			const detail = details?.calls.find((item) => item.id === call.id);
			return detail ? { ...detail, ...call, status: detail.status === "cancelled" ? "cancelled" as const : call.status } : call;
		});
		const extra = details?.calls.filter((call) => !call.id.endsWith("/?") && !calls.some((item) => item.id === call.id)) ?? [];
		return { complete: observed.complete && details?.complete !== false && calls.length + extra.length <= NESTED_CALL_LIMIT, calls: [...calls, ...extra].slice(0, NESTED_CALL_LIMIT) };
	}
	const saved = readCalls((view.result as { nestedCalls?: unknown } | undefined)?.nestedCalls);
	const details = readCalls(view.result?.details);
	const snapshot = saved ?? details;
	if (snapshot) view.row.nested = snapshot;
	return snapshot ?? view.row.nested as CallSnapshot | undefined;
}

function callLine(view: View, call: NestedCall, index: number, width: number, indent: number): string {
	const ms = call.status === "running" && call.startedAt !== undefined ? view.now - call.startedAt : call.durationMs;
	const color = call.status === "error" ? "error" : call.status === "ok" ? "muted" : "dim";
	const rail: Seg[] = [
		...(call.overlapping ? [{ text: "overlap  ", color: "dim" }] : []),
		{ text: WORDS[call.status], color }, ...(ms === undefined ? [] : [{ text: "  ", color: "dim" }, timeSeg(ms)]),
	];
	return numberedLine(view.theme, ` ƒ${index + 1} `, [
		{ text: call.name, color: "text", bold: true }, ...(call.args ? [{ text: ` ${flat(call.args)}`, color: "muted" }] : []),
	], rail, STATES[call.status], width, { indent, now: view.now, motion: view.kit.motion() });
}

function timeline(view: View, width: number): string[] {
	const snapshot = callsOf(view);
	if (!snapshot) return [];
	const hidden = view.context.expanded ? 0 : Math.max(0, snapshot.calls.length - CODEMODE_CALL_PREVIEW);
	const hint = hidden > 0 ? [" ".repeat(BODY_INDENT) + more(view.paint, view.kit, plural(hidden, "earlier call"))] : [];
	const lines = snapshot.calls.slice(hidden).map((call, index) => callLine(view, call, index + hidden, width, BODY_INDENT));
	const incomplete = snapshot.complete ? [] : [" ".repeat(BODY_INDENT) + view.paint.fg("dim", "nested call record incomplete")];
	return [...hint, ...lines, ...incomplete].map((line) => truncateToWidth(line, width, "…"));
}

function callOutput(view: View, call: NestedCall, selected: number, width: number): string[] {
	const lines = [callLine(view, call, selected, width, 0), ...(call.args ? wrapAll([call.args], width) : [])];
	const output = call.output ?? call.error;
	return [...lines, ...wrapAll([output ?? (call.status === "running" ? "(no output yet)" : "(nested result not saved; see script result)")], width)];
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
		head: (view, width, selected) => codeOf(view) ? wrapAll(codeLines(view.paint, view.kit, codeOf(view).split("\n"), "javascript"), width) : fallback.head?.(view, width, selected) ?? [],
		steps: (view) => (callsOf(view)?.calls.length ?? 0) + 1,
		outputLabel: (view, selected) => selected === (callsOf(view)?.calls.length ?? 0) ? "script result" : `tool call ${selected + 1}`,
		output(view, width, selected) {
			const snapshot = callsOf(view);
			const call = snapshot?.calls[selected];
			if (!call) return fallback.output(view, width, selected);
			return callOutput(view, call, selected, width);
		},
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
