/**
 * The bash row. The band holds the command and, on the rail, how it is going:
 * the live time against the timeout, then how it ended. Output sits under the
 * band, its last lines while collapsed.
 *
 * A chained command (`a && b && c`) that ran step by step also gets one line
 * per step, and the output shows under the step that matters: the one
 * running, else the one that failed, else the last one.
 */
import { stripTerminalSequences, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { resolve } from "node:path";
import type { Outcome, Seg } from "../band/band.ts";
import type { ChainRun } from "../chain/run.ts";
import { commandLines, parseShellOutput, sanitize, type ShellOutput } from "./format.ts";
import { codeLines, more, numberArg, plural, resultText, shownPath, tail, textLines, titleSeg, wrapAll, type Kit, type Paint } from "./kit.ts";
import { BODY_INDENT } from "./row.ts";
import { chainTitle, flat, shownSteps, stateOf, stepLine } from "./steps.ts";
import { toolRenderers, type ToolSpec, type View } from "./tool.ts";

/** Output lines under a collapsed row. */
export const OUTPUT_PREVIEW_LINES = 4;
/** Output lines under the focused step of a collapsed chain. */
export const STEP_PREVIEW_LINES = 3;
/** Where a step's output starts: under the step's command, past its number. */
const STEP_OUTPUT_INDENT = 8;

function commandOf(view: View): { text?: string; invalid: boolean } {
	const raw = view.context.args && typeof view.context.args === "object" ? (view.context.args as { command?: unknown }).command : undefined;
	return typeof raw === "string" ? { text: raw, invalid: false } : { invalid: raw !== undefined };
}

function runOf(view: View): ChainRun | undefined {
	const { text } = commandOf(view);
	return text === undefined || !view.kit.chains() ? undefined : view.kit.chainRun(view.context.toolCallId, text);
}

function parsed(view: View): ShellOutput | undefined {
	if (!view.result) return undefined;
	return parseShellOutput(resultText(view.result), !view.context.isPartial && view.context.isError);
}

function outcome(output: ShellOutput | undefined): Outcome | undefined {
	switch (output?.outcome.kind) {
		case "timeout": return "timeout";
		case "aborted": return "aborted";
		case "ok": return "ok";
		case undefined: return undefined;
		default: return "fail";
	}
}

const stepOutput = (run: ChainRun, index: number) => textLines(sanitize(stripTerminalSequences(run.steps[index]?.output ?? "")));

/** Steps shown, and where the one being run or that failed sits among them. */
function position(run: ChainRun): { shown: number[]; at: number } {
	const shown = shownSteps(run.chain, run);
	return { shown, at: Math.max(0, shown.indexOf(run.focus())) + 1 };
}

function details(view: View, run: ChainRun | undefined): string {
	const where = run?.chain.cd ? resolve(view.context.cwd, run.chain.cd.replace(/^~(?=\/|$)/, process.env.HOME ?? "~")) : view.context.cwd;
	const timeout = numberArg(view.context.args, "timeout");
	const parts = [`in ${shownPath(where)}`];
	if (timeout !== undefined) parts.push(`timeout ${timeout}s`);
	if (view.row.startedAt !== undefined) parts.push(`started ${new Date(view.row.startedAt).toLocaleTimeString("en-GB", { hour12: false })}`);
	return parts.join(" · ");
}

/** Output lines with a line saying how many earlier ones are hidden. */
export function preview(paint: Paint, kit: Kit, lines: readonly string[], max: number, width: number): string[] {
	const shown = tail(lines.map((line) => paint.fg("toolOutput", line)), max, width);
	const out = shown.skipped > 0 ? [truncateToWidth(more(paint, kit, plural(shown.skipped, "earlier line")), width, "…")] : [];
	return [...out, ...shown.lines];
}

function chainLines(view: View, run: ChainRun, width: number): string[] {
	const { shown } = position(run);
	const focus = run.focus();
	const pad = " ".repeat(STEP_OUTPUT_INDENT);
	const inner = Math.max(1, width - STEP_OUTPUT_INDENT);
	return shown.flatMap((index, number) => {
		const line = stepLine(view.theme, run.chain, run, index, number + 1, width, { indent: BODY_INDENT, now: view.now });
		const output = stepOutput(run, index);
		const wanted = view.context.expanded ? output.length > 0 : index === focus && output.length > 0;
		if (!wanted) return [line];
		const body = view.context.expanded ? wrapAll(output.map((text) => view.paint.fg("toolOutput", text)), inner) : preview(view.paint, view.kit, output, STEP_PREVIEW_LINES, inner);
		return [line, ...body.map((text) => pad + text)];
	});
}

export const bashSpec: ToolSpec = {
	label(view) {
		const run = runOf(view);
		return run ? `bash · ${plural(position(run).shown.length, "command")}` : "bash";
	},
	title(view) {
		const command = commandOf(view);
		const prompt: Seg = { ...titleSeg("$"), text: "$ " };
		if (command.invalid) return [prompt, { text: "[invalid command]", color: "error" }];
		const run = runOf(view);
		if (run) return [prompt, { text: chainTitle(run.chain), color: "text" }];
		const lines = commandLines(command.text ?? "");
		if (lines.length === 0) return [prompt, { text: "…", color: "muted" }];
		const rest = lines.length > 1 ? [{ text: `  +${plural(lines.length - 1, "line")}`, color: "muted" }] : [];
		return [prompt, { text: lines[0]!, color: "text" }, ...rest];
	},
	timeoutMs(view) {
		const seconds = numberArg(view.context.args, "timeout");
		return seconds !== undefined && seconds > 0 ? seconds * 1_000 : undefined;
	},
	lead(view, phase) {
		const run = runOf(view);
		if (!run) return [];
		const { shown, at } = position(run);
		if (phase.kind === "running") return [{ text: `${at} of ${shown.length}`, color: "muted" }];
		if (phase.kind !== "done") return [];
		const ran = shown.filter((index) => run.steps[index]?.startedAt !== undefined).length;
		return [{ text: ran === shown.length ? plural(shown.length, "command") : `${ran} of ${shown.length} ran`, color: "muted" }];
	},
	failure(view) {
		const output = parsed(view);
		const run = runOf(view);
		const code = run?.steps[run.focus()]?.code;
		const kind = output?.outcome.kind;
		const word: Seg = kind === "timeout" ? { text: "timed out", color: "warning" }
			: kind === "aborted" ? { text: "aborted", color: "muted" }
			: kind === "killed" ? { text: "no exit code", color: "error" }
			: kind === "exit" ? { text: `exit ${run && code !== undefined ? code : output!.outcome.kind === "exit" ? output!.outcome.code : 1}`, color: "error" }
			: { text: "failed", color: "error" };
		if (!run) return [word];
		const { shown, at } = position(run);
		return [word, { text: ` at ${at} of ${shown.length}`, color: "muted" }];
	},
	outcome: (view) => outcome(parsed(view)),
	below(view, width) {
		const run = runOf(view);
		if (run) return chainLines(view, run, width);
		const lines = commandLines(commandOf(view).text ?? "");
		if (!view.context.expanded || lines.length < 2) return [];
		const inner = Math.max(1, width - BODY_INDENT);
		return wrapAll(codeLines(view.paint, view.kit, lines, "bash").slice(1), inner).map((line) => " ".repeat(BODY_INDENT) + line);
	},
	body(view, width) {
		const output = parsed(view);
		if (!output) return [];
		const notice = output.notice ? wrapTextWithAnsi(view.paint.fg("warning", output.notice), width) : [];
		if (runOf(view)) return notice;
		const lines = textLines(output.body);
		const shown = view.context.expanded ? wrapAll(lines.map((line) => view.paint.fg("toolOutput", line)), width) : preview(view.paint, view.kit, lines, OUTPUT_PREVIEW_LINES, width);
		return [...shown, ...notice];
	},
	details: (view) => details(view, runOf(view)),
	head(view, width, selected) {
		const run = runOf(view);
		if (run) return position(run).shown.map((index, number) => stepLine(view.theme, run.chain, run, index, number + 1, width, { indent: 0, now: view.now, selected: number === selected }));
		const lines = commandLines(commandOf(view).text ?? "");
		const code = codeLines(view.paint, view.kit, lines, "bash");
		return wrapAll(code.map((line, index) => (index === 0 ? `${view.paint.fg("accent", view.paint.bold("$"))} ${line}` : `  ${line}`)), width);
	},
	steps: (view) => {
		const run = runOf(view);
		return run ? position(run).shown.length : 0;
	},
	firstStep: (view) => {
		const run = runOf(view);
		return run ? position(run).at - 1 : 0;
	},
	outputLabel(view, selected) {
		const run = runOf(view);
		if (!run) return "output";
		const index = position(run).shown[selected];
		if (index === undefined) return "output";
		const state = stateOf(run, index);
		const text = flat(run.chain.steps[index]!.text);
		return `output of ${selected + 1} · ${text}${state === "skipped" ? " (skipped)" : ""}`;
	},
	output(view, width, selected) {
		const run = runOf(view);
		const paint = view.paint;
		if (run) {
			const index = position(run).shown[selected];
			const lines = index === undefined ? [] : stepOutput(run, index);
			if (lines.length === 0) return [paint.fg("dim", run.done ? "(no output)" : "(no output yet)")];
			return wrapAll(lines.map((line) => paint.fg("toolOutput", line)), width);
		}
		const output = parsed(view);
		const lines = textLines(output?.body ?? "");
		if (lines.length === 0) return [paint.fg("dim", view.context.isPartial ? "(no output yet)" : "(no output)")];
		const notice = output?.notice ? wrapTextWithAnsi(paint.fg("warning", output.notice), width) : [];
		return [...wrapAll(lines.map((line) => paint.fg("toolOutput", line)), width), ...notice];
	},
};

export const bashRenderers = (kit: Kit) => toolRenderers(kit, bashSpec);
