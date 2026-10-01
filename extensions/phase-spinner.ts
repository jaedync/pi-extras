import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { performance } from "node:perf_hooks";
import { join } from "node:path";
import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import {
	formatElapsed,
	parseStatusMessage,
	phaseAfterFirstTokenWait,
	renderLastRunBorder,
	renderPhaseBorder,
	renderPhaseLine,
	renderPlainBorder,
	renderRunBorder,
	type PhaseAlertTone,
	type PhaseBorderPaint,
} from "../lib/phase-status.ts";

import { emptyRunMetrics, updateRunMetrics } from "../lib/phase-metrics.ts";
import { TopBorderLink } from "../lib/top-border.ts";
import { EditorSlot, type StatusIndicator, type WrappedEditor } from "../lib/editor-wrapper.ts";
import { everyFrame } from "../lib/band/clock.ts";
import { TailRow } from "../lib/tail-row.ts";
import { DISPLAY_SETTINGS_EVENT, readSection } from "../lib/extras-config.ts";
import { CHARS_PER_TOKEN, END_ENTRY, parseEndLine, parseVerbs, phaseParts, pickVerb, SEP, renderEndLine, renderPiWave, renderRunLine, runAnimation, smoothTokens, streamRate, type RunLine } from "../lib/cc-phase.ts";
import { MODE_SPINNERS, PI_WAVE, PI_WAVE_MS, REDUCED_FRAME, isBlockingPeer, slotGlyph, spinnerCadence, type GlyphAnimation } from "../lib/band/glyph.ts";
import { renderThinkingTail, thinkingRuns } from "../lib/tool-display/thinking.ts";

type ActivePhase = "prep" | "api" | "first_token" | "think" | "text" | "tool" | "run";
type VisualPhase = ActivePhase | "slow_api" | "stalled";
type ThemeTone = "dim" | "thinkingLow" | "accent" | "thinkingMedium" | "thinkingMinimal" | "mdHeading" | "mdLink" | "toolOutput" | "warning" | "error";
type StatusKind = Exclude<StatusIndicator["kind"], "working">;

interface PhaseStyle {
	label: string;
	tone: ThemeTone;
}

const PHASE_STYLES: Record<VisualPhase, PhaseStyle> = {
	prep: { label: "Preparing", tone: "accent" },
	api: { label: "Sending request", tone: "accent" },
	first_token: { label: "Waiting for first token", tone: "accent" },
	slow_api: { label: "Slow response", tone: "warning" },
	stalled: { label: "Stalled", tone: "error" },
	think: { label: "Thinking", tone: "accent" },
	text: { label: "Writing", tone: "accent" },
	tool: { label: "Calling a tool", tone: "accent" },
	run: { label: "Running", tone: "accent" },
};

interface StatusStyle {
	animation: GlyphAnimation;
	tone: ThemeTone;
	alertTone: PhaseAlertTone;

}

// Pi's non-working statuses (compaction, retry, branch summary) take the phase
// slot. Pi supplies the words; each status gets a spinner that acts out the event.
const STATUS_STYLES: Record<StatusKind, StatusStyle> = {
	// A press squeezing down, then releasing.
	compaction: {
		animation: MODE_SPINNERS.compaction,
		tone: "accent",
		alertTone: "phase",

	},
	// A counter-clockwise lap: rewinding for another attempt.
	retry: {
		animation: MODE_SPINNERS.retry,
		tone: "warning",
		alertTone: "warning",

	},
	// A stem that grows, then sprouts branches down its side.
	branchSummary: {
		animation: MODE_SPINNERS.branchSummary,
		tone: "mdLink",
		alertTone: "phase",

	},
};

// Statuses added by future Pi versions still render, with a generic spinner.
const FALLBACK_STATUS_STYLE: StatusStyle = {
	animation: MODE_SPINNERS.fallback,
	tone: "accent",
	alertTone: "phase",

};

// Wide enough that Pi's status text never wraps or truncates while it is read.
const INDICATOR_TEXT_WIDTH = 1_000;
const SEND_REFRESH_MS = 40;
const DISPLAY_REFRESH_MS = 200;
/** What Pi's working loader shows while held still; this row draws over it. */
const STILL_LOADER_FRAME = REDUCED_FRAME;
const DEBUG_HEARTBEAT_MS = 5_000;
const DEBUG_LOG = join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "phase-spinner-debug.jsonl");
const DEBUG_ENABLED = process.env.PHASE_SPINNER_DEBUG === "1";
/** Marks an indicator whose dispose this copy of the extension already watches. */
const DISPOSE_WATCHED = Symbol("phase-spinner.dispose-watched");

interface VisualState {
	phase: VisualPhase;
	elapsedMs: number;
	style: PhaseStyle;
	alertTone: PhaseAlertTone;
}

interface StatusView {
	spinner: string;
	elapsedMs: number;
	label: string;
	detail?: string;
	style: StatusStyle;
}

function latestToolName(message: object): string | undefined {
	const content = "content" in message && Array.isArray(message.content) ? (message.content as { type?: string; name?: string }[]) : [];
	return [...content].reverse().find((part) => part.type === "toolCall" && part.name)?.name;
}

/** Pi's status text without Pi's own spinner frame. */
function indicatorText(indicator: StatusIndicator): string {
	const line = stripTerminalSequences(indicator.renderInBorder(INDICATOR_TEXT_WIDTH));
	const spinner = stripTerminalSequences(indicator.renderSpinnerInBorder(INDICATOR_TEXT_WIDTH));
	return spinner && line.startsWith(spinner) ? line.slice(spinner.length) : line;
}

export default function phaseSpinner(pi: ExtensionAPI): void {
	pi.registerEntryRenderer(END_ENTRY, (entry, _options, theme) => {
		const data = parseEndLine(entry.data);
		return data ? { render: (width) => [renderEndLine(data, width, theme)], invalidate() {} } : undefined;
	});
	let verb = pickVerb(parseVerbs(undefined));
	let verbs = parseVerbs(undefined);
	let reduced = false;
	let streamedChars = 0;
	let shownTokens = 0;
	let tokensAt = 0;
	let lastTokenAt = 0;
	let rate = { at: 0, chars: 0, rate: 0, waveMs: 0 };
	let retryDelayMs: number | undefined;
	let wave: { at: number; theme: ExtensionContext["ui"]["theme"] } | undefined;
	let reachedAgentEnd = false;
	let continuationPending = false;
	let endReason: string | undefined;
	let cancelled = false;
	let liveThinking = "";
	let thinkingMode: unknown = "tail";
	let hidesLiveThinking = false;
	let tailCache: { text: string; width: number; theme: ExtensionContext["ui"]["theme"]; lines: string[] } | undefined;
	let thoughtMs: number | undefined;
	let thoughtEndedAt = Number.NEGATIVE_INFINITY;
	let active = false;
	let metrics = emptyRunMetrics();
	let phase: ActivePhase = "prep";
	let phaseStartedAt = performance.now();
	let agentStartedAt = phaseStartedAt;
	let lineStartedAt = phaseStartedAt;
	let runEnded = true;
	let renderedPhase: VisualPhase | undefined;
	let stopFrames: (() => void) | undefined;
	let frameMs: number | undefined;
	let lastDrawing: string | undefined;
	let activeTui: TUI | undefined;
	let currentContext: ExtensionContext | undefined;
	let lastDebugAt = performance.now();
	type RunningTool = { name: string; blocking: boolean; parent?: string };
	let runningTools = new Map<string, RunningTool>();
	const leafTools = () => {
		const tools = [...runningTools.entries()];
		const parents = new Set(tools.map(([,tool]) => tool.parent).filter(Boolean));
		return tools.filter(([id]) => !parents.has(id)).map(([,tool]) => tool);
	};
	let pendingToolName: string | undefined;
	let lastTotalElapsedMs: number | undefined;
	const editorSlot = new EditorSlot();
	let statusIndicator: StatusIndicator | undefined;
	let statusShownAt = 0;
	// First sighting per status kind, so the timer spans a whole event (every retry attempt).
	let statusEpisodes = new Map<string, number>();
	let lastRequestAt = Number.NEGATIVE_INFINITY;
	let topBorder: TopBorderLink | undefined;
	/** This run's row has been drawn over Pi's working loader, so the loader is out of sight. */
	let paintedOver = false;
	/** Where Pi's loader was held still, to let it move again when the run ends. */
	let stillLoader: ExtensionContext | undefined;
	/** The phase's own line under the transcript; until it finds its place, the phase stays in the border. */
	const tailRow = new TailRow();
	let linePaint: Paint | undefined;

	/** Voice records in the top row only while this is false. */
	function announceBusy(): void {
		topBorder?.set(active || statusIndicator !== undefined || wave !== undefined);
	}

	function ensureTimer(): void {
		const now = performance.now();
		const status = statusView(now);
		if (!active && !status && !wave) { releaseTimer(); return; }
		const tools = leafTools();
		const peer = phase === "run" && tools.length > 0 && tools.every(tool => tool.blocking);
		const animation = status?.style.animation ?? MODE_SPINNERS[peer ? "peer" : phase];
		const cadence = spinnerCadence(animation, reduced, rate.rate, !!status && animation.kind === "fraction" && retryDelayMs !== undefined);
		const shimmer = reduced ? 1000 : !status && phase === "api" ? SEND_REFRESH_MS : DISPLAY_REFRESH_MS;
		const desired = wave ? PI_WAVE.stepMs : Math.ceil(Math.min(cadence, shimmer));
		if (stopFrames && frameMs === desired) return;
		stopFrames?.();
		frameMs = desired;
		stopFrames = everyFrame(() => tick(), desired);
	}

	function releaseTimer(): void {
		if (!stopFrames || active || statusView(performance.now()) || wave) return;
		stopFrames();
		stopFrames = undefined;
	}

	/**
	 * Ends a status when Pi disposes its indicator. Pi tells only the editor it
	 * has mounted now; if another extension replaced ours meanwhile, the clear
	 * never reaches it, and the phase line would show the status for good.
	 */
	function endOnDispose(indicator: StatusIndicator): void {
		const target = indicator as StatusIndicator & { dispose?: () => void; [DISPOSE_WATCHED]?: true };
		if (typeof target.dispose !== "function" || target[DISPOSE_WATCHED]) return;
		const dispose = target.dispose;
		target[DISPOSE_WATCHED] = true;
		target.dispose = function (this: unknown) {
			dispose.call(this);
			if (statusIndicator === indicator) noteStatusIndicator(undefined);
		};
	}

	function noteStatusIndicator(indicator: StatusIndicator | undefined): void {
		if (!indicator || indicator.kind === "working") {
			statusIndicator = undefined;
			// Pi clears the slot before every replacement; only a clear that sticks ends the event.
			queueMicrotask(() => {
				if (statusIndicator) return;
				statusEpisodes = new Map();
				releaseTimer();
				announceBusy();
			});
			activeTui?.requestRender();
			return;
		}
		const now = performance.now();
		endOnDispose(indicator);
		statusIndicator = indicator;
		statusShownAt = now;
		cancelWave();
		if (indicator.kind === "retry") {
			const delay = (indicator as StatusIndicator & { delayMs?: unknown }).delayMs;
			retryDelayMs = typeof delay === "number" && Number.isFinite(delay) && delay > 0 ? delay : undefined;
		}
		if (!statusEpisodes.has(indicator.kind)) statusEpisodes = new Map(statusEpisodes).set(indicator.kind, now);
		ensureTimer();
		announceBusy();
		activeTui?.requestRender();
	}

	function resetStatus(): void {
		statusIndicator = undefined;
		statusEpisodes = new Map();
		lastRequestAt = Number.NEGATIVE_INFINITY;
		retryDelayMs = undefined;
	}

	function statusView(now: number): StatusView | undefined {
		const indicator = statusIndicator;
		if (!indicator) return undefined;
		// Pi keeps the retry status up through the retried request; live phases are more useful there.
		if (indicator.kind === "retry" && lastRequestAt >= statusShownAt) return undefined;
		const style = (STATUS_STYLES as Partial<Record<string, StatusStyle>>)[indicator.kind] ?? FALLBACK_STATUS_STYLE;
		const elapsedMs = Math.max(0, now - (statusEpisodes.get(indicator.kind) ?? statusShownAt));
		const { label, detail } = parseStatusMessage(indicatorText(indicator));
		const fraction = indicator.kind === "retry" && retryDelayMs !== undefined ? Math.max(0, now - statusShownAt) / retryDelayMs : undefined;
		const spinner = slotGlyph(style.animation, elapsedMs, { reduced, fraction });
		return { spinner, elapsedMs, label, detail, style };
	}

	function visualState(now: number): VisualState {
		const elapsedMs = now - phaseStartedAt;
		if (phase !== "first_token") {
			return { phase, elapsedMs, style: PHASE_STYLES[phase], alertTone: "phase" };
		}
		const wait = phaseAfterFirstTokenWait(elapsedMs);
		const visualPhase = wait.tone === "error" ? "stalled" : wait.tone === "warning" ? "slow_api" : "first_token";
		return { phase: visualPhase, elapsedMs, style: PHASE_STYLES[visualPhase], alertTone: wait.tone };
	}

	function debugState(event: string, ctx: ExtensionContext, now = performance.now(), details?: Record<string, unknown>): void {
		lastDebugAt = now;
		if (!DEBUG_ENABLED) return;
		const state = visualState(now);
		const entry = {
			at: new Date().toISOString(),
			sessionId: ctx.sessionManager.getSessionId(),
			event,
			phase,
			visualPhase: state.phase,
			display: `${formatElapsed(state.elapsedMs)} ${state.style.label}`,
			phaseElapsedMs: Math.floor(now - phaseStartedAt),
			totalElapsedMs: Math.floor(now - agentStartedAt),
			runningTools: runningTools.size,
			provider: ctx.model?.provider,
			model: ctx.model?.id,
			...details,
		};
		try {
			appendFileSync(DEBUG_LOG, `${JSON.stringify(entry)}\n`, "utf8");
		} catch {
			// Debug logging must not interrupt the agent.
		}
	}

	function tick(now = performance.now()): void {
		if (wave && now - wave.at >= PI_WAVE_MS) {
			wave = undefined;
			lastDrawing = undefined;
			announceBusy();
			releaseTimer();
			activeTui?.requestRender();
		}
		if (active && currentContext) {
			const state = visualState(now);
			if (renderedPhase !== state.phase) {
				const previousVisualPhase = renderedPhase;
				renderedPhase = state.phase;
				debugState("visual_phase", currentContext, now, { previousVisualPhase });
			}
			if (now - lastDebugAt >= DEBUG_HEARTBEAT_MS) debugState("heartbeat", currentContext, now);
			if (paintedOver && !stillLoader) holdLoaderStill(currentContext);
		} else if (!statusIndicator && !wave) {
			return;
		}
		if (!activeTui) return;
		const width = activeTui.terminal?.columns ?? 120;
		const drawing = drawPhaseLine(width, now).join("\n") + borderFingerprint(now, width);
		ensureTimer();
		if (drawing === lastDrawing) return;
		lastDrawing = drawing;
		activeTui?.requestRender();
	}

	function setPhase(next: ActivePhase, ctx: ExtensionContext, cause: string, forceLog = false, details?: Record<string, unknown>): void {
		const now = performance.now();
		const previousPhase = phase;
		const previousVisualPhase = visualState(now).phase;
		currentContext = ctx;
		if (phase !== next) {
			if (phase === "think") {
				thoughtMs = now - phaseStartedAt;
				thoughtEndedAt = now;
				liveThinking = "";
			}
			phase = next;
			phaseStartedAt = now;
			renderedPhase = undefined;
		}
		if (previousPhase !== phase || forceLog) {
			debugState(cause, ctx, now, { previousPhase, previousVisualPhase, ...details });
		}
		if (active || statusIndicator) ensureTimer();
		tick(now);
	}

	/**
	 * Pi's working loader keeps its own timer, and every tick redraws the whole
	 * screen, though this row covers it. With one frame it has no timer; the
	 * row's own spinner is unchanged.
	 */
	function holdLoaderStill(ctx: ExtensionContext): void {
		if (typeof ctx.ui.setWorkingIndicator !== "function") return;
		try {
			ctx.ui.setWorkingIndicator({ frames: [STILL_LOADER_FRAME] });
			stillLoader = ctx;
		} catch {
			// The loader keeps moving; that only costs frames.
		}
	}

	function releaseLoader(): void {
		const ctx = stillLoader;
		stillLoader = undefined;
		paintedOver = false;
		try {
			ctx?.ui.setWorkingIndicator(undefined);
		} catch {
			// A session that has ended resets its loader itself.
		}
	}

	function cancelWave(): void {
		if (!wave) return;
		wave = undefined;
		lastDrawing = undefined;
		announceBusy();
		releaseTimer();
		activeTui?.requestRender();
	}

	function start(ctx: ExtensionContext): void {
		if (active && reachedAgentEnd && !continuationPending) finishPrompt(ctx, false);
		cancelWave();
		reachedAgentEnd = false;
		continuationPending = false;
		endReason = undefined;
		cancelled = false;
		const now = performance.now();
		metrics = updateRunMetrics(metrics, { type: "start" });
		currentContext = ctx;
		phase = "prep";
		phaseStartedAt = now;
		renderedPhase = undefined;
		runningTools = new Map();
		pendingToolName = undefined;
		if (!active) {
			lineStartedAt = now;
			runEnded = false;
			verb = pickVerb(verbs);
			streamedChars = 0;
			shownTokens = 0;
			tokensAt = now;
			lastTokenAt = now;
			rate = { at: now, chars: 0, rate: 0, waveMs: 0 };
			thoughtMs = undefined;
			liveThinking = "";
			lastDrawing = undefined;
			active = true;
			agentStartedAt = now;
			lastDebugAt = now;
			ensureTimer();
		}
		debugState("agent_start", ctx, now, { resumedActiveRun: active && agentStartedAt !== now });
		ensureTimer();
		announceBusy();
		tick(now);
	}

	function finishPrompt(ctx: ExtensionContext, animate = true): void {
		if (!active || runEnded) return;
		const stopped = cancelled || endReason === "aborted";
		const waveTheme = animate && !stopped && !reduced && activeTui ? ctx.ui.theme : undefined;
		if (ctx.mode === "tui") pi.appendEntry(END_ENTRY, {
			past: verb.past, elapsedMs: performance.now() - lineStartedAt,
			doneAt: new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }),
			...(stopped ? { stopped: true } : {}),
		});
		runEnded = true;
		stop(true);
		if (waveTheme) {
			wave = { at: performance.now(), theme: waveTheme };
			announceBusy(); ensureTimer(); tick();
		}
	}

	function stop(persistLastRun = false): void {
		wave = undefined;
		tailCache = undefined;
		metrics = updateRunMetrics(metrics, { type: persistLastRun ? "settle" : "reset" });
		if (active && persistLastRun) lastTotalElapsedMs = performance.now() - agentStartedAt;
		else if (!persistLastRun) lastTotalElapsedMs = undefined;
		active = false;
		currentContext = undefined;
		runningTools = new Map();
		pendingToolName = undefined;
		renderedPhase = undefined;
		releaseLoader();
		releaseTimer();
		announceBusy();
		activeTui?.requestRender();
	}

	type Paint = (tone: ThemeTone) => PhaseBorderPaint;

	function runLine(now: number): RunLine {
		rate = streamRate(rate, now, streamedChars);
		const target = Math.round(streamedChars / CHARS_PER_TOKEN);
		shownTokens = reduced ? target : smoothTokens(shownTokens, target, now - tokensAt);
		tokensAt += Math.floor(Math.max(0, now - tokensAt) / 50) * 50;
		return { verb, phase, elapsedMs: now - lineStartedAt, phaseMs: now - phaseStartedAt,
			tokens: shownTokens, clockMs: now - lineStartedAt, reduced, tools: leafTools().map(tool => tool.name),
			waitingOnPeers: leafTools().length > 0 && leafTools().every(tool => tool.blocking),
			pendingTool: pendingToolName, thoughtMs, sinceThoughtMs: now - thoughtEndedAt,
			idleTokenMs: now - lastTokenAt, waveMs: rate.waveMs, tokensPerSecond: rate.rate };
	}

	function activeBorder(now: number, width: number, hiddenLineCount: number, paint: Paint): string {
		const state = visualState(now);
		const model = runLine(now);
		return renderPhaseBorder({
			spinner: slotGlyph(runAnimation(model), model.clockMs, { reduced, rateElapsedMs: model.waveMs }),
			phaseElapsedMs: state.elapsedMs,
			totalElapsedMs: now - agentStartedAt,
			metrics,
			label: `${verb.present}…`,
			detail: phaseParts(model).join(SEP),
			tone: state.alertTone,
			hiddenLineCount,
		}, width, paint(state.style.tone));
	}

	function borderFingerprint(now: number, width: number): string {
		if (!linePaint) return "";
		const status = statusView(now);
		if (active && currentContext) return tailRow.attached
			? renderRunBorder(now - agentStartedAt, width, linePaint("accent"), 0, metrics)
			: activeBorder(now, width, 0, linePaint);
		if (status && !tailRow.attached) return statusBorder(status, now, width, 0, linePaint);
		return lastTotalElapsedMs === undefined ? "" : renderLastRunBorder(lastTotalElapsedMs, width, linePaint("accent"), 0, metrics);
	}

	function statusBorder(status: StatusView, now: number, width: number, hiddenLineCount: number, paint: Paint): string {
		// Idle statuses (manual /compact) have no run span; the event is the whole span.
		const totalElapsedMs = active ? now - agentStartedAt : status.elapsedMs;
		return renderPhaseBorder({
			spinner: status.spinner,
			phaseElapsedMs: status.elapsedMs,
			totalElapsedMs,
			metrics: active ? metrics : undefined,
			label: status.label,
			detail: status.detail,
			tone: status.style.alertTone,
			hiddenLineCount,
		}, width, paint(status.style.tone));
	}

	/**
	 * The line under the transcript, above the queued messages: a Pi status,
	 * else the live phase, set apart by a blank line like the transcript's
	 * entries. Nothing while idle.
	 */
	function drawPhaseLine(width: number, now = performance.now()): string[] {
		const paint = linePaint;
		if (!paint) return [];
		if (wave) {
			const line = renderPiWave(now - wave.at, wave.theme, width);
			return line ? ["", line] : [];
		}
		const status = statusView(now);
		if (status) {
			const { spinner, elapsedMs, label, detail, style } = status;
			return ["", renderPhaseLine({ spinner, elapsedMs, label, detail, tone: style.alertTone }, width, paint(style.tone))];
		}
		if (!active || runEnded || !currentContext) return [];
		const theme = currentContext.ui.theme;
		return ["", renderRunLine(runLine(now), width, theme),
			...(hidesLiveThinking && phase === "think" && thinkingMode !== "collapsed" ? thinkingTail(width, theme) : [])];
	}

	function thinkingTail(width: number, theme: ExtensionContext["ui"]["theme"]): string[] {
		if (tailCache?.text === liveThinking && tailCache.width === width && tailCache.theme === theme) return tailCache.lines;
		const lines = renderThinkingTail(liveThinking, width, theme);
		tailCache = { text: liveThinking, width, theme, lines };
		return lines;
	}

	function lastRunRow(lines: string[], width: number, paint: Paint, hiddenLineCount: number): string[] {
		// A recording borrows the idle row; the summary returns when it ends.
		if (lastTotalElapsedMs === undefined || topBorder?.peerActive) return lines;
		return [renderLastRunBorder(lastTotalElapsedMs, width, paint("accent"), hiddenLineCount, metrics), ...lines.slice(1)];
	}

	/**
	 * The editor's top row. With the phase line in place: the run's metrics and
	 * total time, or the last run's. Otherwise the phase or a Pi status is drawn
	 * here too.
	 */
	function drawTopRow(lines: string[], width: number, paint: Paint, editor: WrappedEditor): string[] {
		// Pi draws the editor once it is mounted, so its place in Pi's layout is known by now.
		if (!tailRow.attached && activeTui) tailRow.attach(activeTui, editor, drawPhaseLine);
		const match = stripTerminalSequences(lines[0] ?? "").match(/↑\s*(\d+)/);
		const hiddenLineCount = match ? Number.parseInt(match[1] ?? "0", 10) : 0;
		const now = performance.now();
		if (tailRow.attached) {
			if (active && currentContext) {
				paintedOver = true;
				return [renderRunBorder(now - agentStartedAt, width, paint("accent"), hiddenLineCount, metrics), ...lines.slice(1)];
			}
			if (!statusIndicator) return lastRunRow(lines, width, paint, hiddenLineCount);
			// The phase line shows Pi's status; the editor would draw it in this row as well.
			const summary = lastTotalElapsedMs === undefined
				? renderPlainBorder(width, paint("accent"), hiddenLineCount)
				: renderLastRunBorder(lastTotalElapsedMs, width, paint("accent"), hiddenLineCount, metrics);
			return [summary, ...lines.slice(1)];
		}
		if (wave && now - wave.at < PI_WAVE_MS) {
			const glyph = renderPiWave(now - wave.at, wave.theme, width);
			const line = truncateToWidth(`─ ${glyph} ${wave.theme.fg("dim", "─".repeat(Math.max(0, width - 7)))}`, width, "");
			return [line, ...lines.slice(1)];
		}
		const status = statusView(now);
		if (status) return [statusBorder(status, now, width, hiddenLineCount, paint), ...lines.slice(1)];
		if (active && currentContext) {
			paintedOver = true;
			return [activeBorder(now, width, hiddenLineCount, paint), ...lines.slice(1)];
		}
		return lastRunRow(lines, width, paint, hiddenLineCount);
	}

	pi.on("session_start", (_event, ctx) => {
		topBorder?.dispose();
		topBorder = new TopBorderLink(pi.events, "phase-spinner", () => activeTui?.requestRender());
		resetStatus();
		stop();
		verbs = parseVerbs(readSection("phaseSpinner").verbs);
		const display = readSection("toolDisplay");
		reduced = display.motion === "reduced";
		thinkingMode = display.thinking ?? "tail";
		tailRow.detach();
		const painter = (border: (text: string) => string): Paint => (tone) => {
			const thm = currentContext?.ui.theme ?? ctx.ui.theme;
			return {
				border,
				phase: (text) => thm.fg(tone, text),
				dim: (text) => thm.fg("dim", text),
				total: (text) => thm.fg("muted", text),
				warning: (text) => thm.fg("warning", text),
				error: (text) => thm.fg("error", text),
				measure: visibleWidth,
				truncate: (text, maxWidth) => truncateToWidth(text, maxWidth, ""),
			};
		};
		linePaint = painter((text) => text);
		editorSlot.install(ctx, (tui) => {
			activeTui = tui;
			return {
				render: (lines, width, editor) => drawTopRow(lines, width, painter((text) => editor.borderColor(text)), editor),
				onWorkingStatus: noteStatusIndicator,
				onEscape: () => { if (active && currentContext && !currentContext.isIdle()) cancelled = true; },
			};
		});
		topBorder.hello();
	});

	pi.events?.on(DISPLAY_SETTINGS_EVENT, (value) => {
		const settings = value as { motion?: unknown; thinking?: unknown; hidesLiveThinking?: unknown };
		if (settings?.motion !== undefined) reduced = settings.motion === "reduced";
		if (reduced) cancelWave();
		if (settings?.thinking !== undefined) thinkingMode = settings.thinking;
		if (typeof settings?.hidesLiveThinking === "boolean") hidesLiveThinking = settings.hidesLiveThinking;
		stopFrames?.();
		stopFrames = undefined;
		if (active || statusIndicator || wave) ensureTimer();
		tick();
	});
	pi.on("input", (_event, ctx) => {
		if (active && ctx.isIdle()) finishPrompt(ctx, false);
		else if (active) continuationPending = true;
		cancelWave();
	});
	pi.on("before_agent_start", (_event, ctx) => { if (active && ctx.isIdle()) finishPrompt(ctx, false); });
	// Later boundary handlers can request continuation without adding a queued message.
	pi.on("agent_before_settle", () => { continuationPending = true; });
	pi.on("session_before_compact", (event) => { if (event.reason === "overflow") continuationPending = true; });
	pi.on("agent_start", (_event, ctx) => start(ctx));
	pi.on("turn_start", (_event, ctx) => setPhase("prep", ctx, "turn_start", true));
	pi.on("context", (_event, ctx) => setPhase("prep", ctx, "context", true));
	pi.on("before_provider_request", (_event, ctx) => {
		lastRequestAt = performance.now();
		lastTokenAt = lastRequestAt;
		metrics = updateRunMetrics(metrics, { type: "request", at: lastRequestAt });
		setPhase("api", ctx, "before_provider_request", true);
	});
	pi.on("after_provider_response", (event, ctx) => setPhase("first_token", ctx, "after_provider_response", true, { status: event.status }));
	pi.on("message_start", (event, ctx) => {
		if (event.message.role === "assistant") setPhase("first_token", ctx, "message_start", true);
	});
	pi.on("message_update", (event, ctx) => {
		if (event.message.role !== "assistant") return;
		const streamEvent = event.assistantMessageEvent;
		const eventType = streamEvent.type;
		if ("delta" in streamEvent && typeof streamEvent.delta === "string" && eventType.endsWith("_delta")) {
			streamedChars += streamEvent.delta.length;
			lastTokenAt = performance.now();
		}
		metrics = updateRunMetrics(metrics, {
			type: "delta", at: performance.now(), kind: eventType,
			delta: "delta" in streamEvent ? streamEvent.delta : undefined,
		});
		if (eventType === "thinking_end") setPhase("prep", ctx, eventType);
		else if (eventType.startsWith("thinking_")) {
			const runs = thinkingRuns(event.message.content);
			liveThinking = runs.at(-1) ?? (liveThinking + ("delta" in streamEvent ? streamEvent.delta : ""));
			setPhase("think", ctx, eventType);
		}
		else if (eventType.startsWith("text_")) setPhase("text", ctx, eventType);
		else if (eventType.startsWith("toolcall_")) {
			pendingToolName = latestToolName(event.message);
			setPhase("tool", ctx, eventType);
		}
	});
	pi.on("message_end", (event, ctx) => {
		if (event.message.role === "assistant") endReason = event.message.stopReason;
		if (event.message.role !== "assistant") return;
		if (phase === "think") setPhase("prep", ctx, "thinking_finished");
		// Whole-request throughput includes initial wait and final stream metadata.
		// usage.output already includes reasoning tokens; do not add them again.
		metrics = updateRunMetrics(metrics, {
			type: "end", at: performance.now(),
			output: event.message.usage?.output, stopReason: event.message.stopReason,
		});
		debugState("message_end", ctx, performance.now(), { stopReason: event.message.stopReason });
		tick();
	});
	pi.on("tool_execution_start", (event, ctx) => {
		runningTools = new Map(runningTools).set(event.toolCallId, { name: event.toolName, blocking: isBlockingPeer(event.toolName, event.args), parent: (event as {parentToolCallId?:string}).parentToolCallId });
		setPhase("run", ctx, "tool_execution_start", true, { tool: event.toolName });
	});
	pi.on("tool_execution_update", (_event, ctx) => setPhase("run", ctx, "tool_execution_update"));
	pi.on("tool_execution_end", (event, ctx) => {
		const nextTools = new Map(runningTools);
		nextTools.delete(event.toolCallId);
		runningTools = nextTools;
		setPhase(runningTools.size > 0 ? "run" : "prep", ctx, "tool_execution_end", true, {
			tool: event.toolName,
			isError: event.isError,
		});
	});
	pi.on("turn_end", (_event, ctx) => {
		if (runningTools.size === 0) setPhase("prep", ctx, "turn_end", true);
	});
	pi.on("agent_end", (_event, ctx) => {
		debugState("agent_end", ctx);
		liveThinking = "";
		reachedAgentEnd = true;
		continuationPending = (endReason !== "stop" && endReason !== "toolUse") || ctx.hasPendingMessages();
		if (cancelled || endReason === "aborted") finishPrompt(ctx);
	});
	pi.on("agent_settled", (_event, ctx) => {
		debugState("agent_settled", ctx);
		if (ctx.isIdle()) finishPrompt(ctx);
	});
	pi.on("session_shutdown", (_event, ctx) => {
		if (active) debugState("session_shutdown", ctx);
		hidesLiveThinking = false;
		resetStatus();
		stop();
		tailRow.detach();
		linePaint = undefined;
		topBorder?.dispose();
		topBorder = undefined;
		activeTui = undefined;
		editorSlot.restore(ctx);
	});
}
