/**
 * The bash row. The command is highlighted and, collapsed, cut to its first
 * lines; the header ends with the run time and, on failure, how the command
 * ended, so the status lines Pi appends to failed output are not repeated in
 * the body. Output collapses to its last lines, as Pi's own row does.
 */
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { formatDuration } from "../shell-jobs-core.ts";
import { commandLines, parseShellOutput, type ShellOutcome } from "./format.ts";
import { Lines, type Paint, type PaintKey } from "./slot.ts";
import { codeLines, header, meta, more, numberArg, plural, resultText, slotFor, tail, wrapAll, type Kit, type RenderContext, type ThemeLike } from "./kit.ts";

/** Command lines shown collapsed, the prompt line included. */
export const COMMAND_PREVIEW_LINES = 3;
/** Output lines shown collapsed; the same as Pi's bash row. */
export const OUTPUT_PREVIEW_LINES = 5;
const TICK_MS = 1000;
const INDENT = "  ";

interface ShellState {
	startedAt?: number;
	endedAt?: number;
	outcome?: ShellOutcome;
	ticker?: ReturnType<typeof setInterval>;
}

function outcomeMeta(outcome: ShellOutcome | undefined): readonly [PaintKey, string] | undefined {
	switch (outcome?.kind) {
		case "exit": return ["error", `exit ${outcome.code}`];
		case "timeout": return ["error", `timed out after ${outcome.seconds}s`];
		case "aborted": return ["warning", "aborted"];
		case "killed": return ["error", "no exit code"];
		case "failed": return ["error", "failed"];
		default: return undefined;
	}
}

export function shellMeta(paint: Paint, kit: Kit, args: unknown, shell: ShellState): string {
	const timeout = numberArg(args, "timeout");
	const shown = timeout !== undefined ? `timeout ${timeout}s` : "";
	const elapsed = shell.startedAt === undefined ? "" : formatDuration((shell.endedAt ?? kit.now()) - shell.startedAt);
	return meta(paint, [["muted", shown], outcomeMeta(shell.outcome), ["muted", elapsed]]);
}

export function callLines(paint: Paint, kit: Kit, args: unknown, tailText: string, width: number, expanded: boolean): string[] {
	const raw = args && typeof args === "object" ? (args as { command?: unknown }).command : undefined;
	const prompt = `${paint.fg("toolTitle", paint.bold("$"))} `;
	if (raw !== undefined && typeof raw !== "string") return header(prompt + paint.fg("error", "[invalid command]"), tailText, width, expanded);
	const lines = commandLines(raw ?? "");
	if (lines.length === 0) return header(prompt + paint.fg("toolOutput", "…"), tailText, width, expanded);
	const code = codeLines(paint, kit, lines, "bash");
	const first = header(prompt + code[0]!, tailText, width, expanded);
	const inner = Math.max(1, width - INDENT.length);
	if (expanded) return [...first, ...wrapAll(code.slice(1), inner).map((line) => INDENT + line)];
	const rest = code.slice(1, COMMAND_PREVIEW_LINES).map((line) => INDENT + truncateToWidth(line, inner, "…"));
	const hidden = lines.length - 1 - rest.length;
	return hidden > 0 ? [...first, ...rest, INDENT + truncateToWidth(more(paint, kit, plural(hidden, "more line")), inner, "…")] : [...first, ...rest];
}

export function outputLines(paint: Paint, kit: Kit, body: string, notice: string | undefined, width: number, expanded: boolean): string[] {
	const lines = body.trim() === "" ? [] : body.replace(/\n+$/, "").split("\n").map((line) => paint.fg("toolOutput", line));
	const out: string[] = [];
	if (expanded) {
		out.push(...wrapAll(lines, width));
	} else {
		const shown = tail(lines, OUTPUT_PREVIEW_LINES, width);
		if (shown.skipped > 0) out.push(truncateToWidth(more(paint, kit, plural(shown.skipped, "earlier line")), width, "…"));
		out.push(...shown.lines);
	}
	if (notice) out.push(...wrapTextWithAnsi(paint.fg("warning", notice), width));
	return out;
}

export function bashRenderers(kit: Kit) {
	// Every running row's timer, so a session switch can stop timers whose rows are gone.
	const tickers = new Set<ReturnType<typeof setInterval>>();
	const stop = (shell: ShellState) => {
		if (shell.ticker) {
			clearInterval(shell.ticker);
			tickers.delete(shell.ticker);
		}
		shell.ticker = undefined;
	};
	return {
		stopTimers() {
			for (const ticker of tickers) clearInterval(ticker);
			tickers.clear();
		},
		renderCall(_args: unknown, theme: ThemeLike, context: RenderContext) {
			const { slot, state } = slotFor("call", kit, theme, context);
			const shell = (state.shell ??= {}) as ShellState;
			if (context.executionStarted && shell.startedAt === undefined) shell.startedAt = kit.now();
			return slot.setBody(new Lines((width) => {
				const paint = state.paint as Paint;
				return callLines(paint, kit, context.args, shellMeta(paint, kit, context.args, shell), width, context.expanded);
			}));
		},
		renderResult(result: { content?: unknown }, options: { expanded: boolean; isPartial: boolean }, theme: ThemeLike, context: RenderContext) {
			const { slot, paint, state } = slotFor("result", kit, theme, context);
			const shell = (state.shell ??= {}) as ShellState;
			const done = !options.isPartial || context.isError;
			const parsed = parseShellOutput(resultText(result), done && context.isError);
			if (done) {
				shell.outcome = parsed.outcome;
				if (shell.startedAt !== undefined) shell.endedAt ??= kit.now();
				stop(shell);
			} else if (shell.startedAt !== undefined && !shell.ticker) {
				// Keeps the elapsed time in the header moving while the command runs.
				shell.ticker = setInterval(() => context.invalidate(), TICK_MS);
				shell.ticker.unref?.();
				tickers.add(shell.ticker);
			}
			return slot.setBody(new Lines((width) => outputLines(paint, kit, parsed.body, parsed.notice, width, options.expanded)));
		},
	};
}
