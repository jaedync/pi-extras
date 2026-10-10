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
	type PhaseBorderPaint,
} from "../lib/phase-status.ts";

import { averageTps, emptyRunMetrics, updateRunMetrics } from "../lib/phase-metrics.ts";
import { emptyLiveRate, liveTokensPerSecond, noteArrival, type LiveRate } from "../lib/live-rate.ts";
import { TopBorderLink } from "../lib/top-border.ts";
import { EditorSlot, type StatusIndicator, type WrappedEditor } from "../lib/editor-wrapper.ts";
import { everyFrame } from "../lib/band/clock.ts";
import { TailRow } from "../lib/tail-row.ts";
import { DISPLAY_SETTINGS_EVENT, FOLD_LIVE_EVENT, readSection } from "../lib/extras-config.ts";
import { renderStatusDivider } from "../lib/status-divider.ts";
import { CHARS_PER_TOKEN, END_ENTRY, parseEndLine, parseVerbs, pickVerb, renderEndLine, renderPiWave, renderRunStatus, smoothTokens, streamRate, type RunLine } from "../lib/cc-phase.ts";
import { MODE_SPINNERS, PI_WAVE, PI_WAVE_MS, REDUCED_FRAME, isBlockingPeer, slotGlyph, spinnerCadence, type GlyphAnimation } from "../lib/band/glyph.ts";
import { renderThinkingTail, thinkingRuns } from "../lib/tool-display/thinking.ts";
import { glowing, noteText, type Trail } from "../lib/band/glow.ts";
import { cancelLive, liveCompactionLines, liveShown, noteProgress, startLive, type LiveCompaction } from "../lib/compaction-live.ts";
import { COMPACTION_PROGRESS_EVENT, readProgress } from "../lib/cache-compaction/decision.ts";
import type { ThemeLike } from "../lib/tool-display/kit.ts";

function sessionIdOf(ctx: ExtensionContext): string | undefined {
	try { return ctx.sessionManager?.getSessionId?.(); } catch { return undefined; }
}

type ActivePhase = "prep" | "api" | "first_token" | "think" | "text" | "tool" | "run";
type VisualPhase = ActivePhase | "slow_api" | "stalled";
type ThemeTone = "dim" | "thinkingLow" | "accent" | "thinkingMedium" | "thinkingMinimal" | "mdHeading" | "mdLink" | "toolOutput" | "warning" | "error";
type StatusKind = Exclude<StatusIndicator["kind"], "working">;

interface StatusStyle {
	animation: GlyphAnimation;
	tone: ThemeTone;
}

// Pi's non-working statuses (compaction, retry, branch summary) take the phase
// slot. Pi supplies the words; each status gets a spinner that acts out the event.
const STATUS_STYLES: Record<StatusKind, StatusStyle> = {
	// A press squeezing down, then releasing.
	compaction: {
		animation: MODE_SPINNERS.compaction,
		tone: "accent",
	},
	// A counter-clockwise lap: rewinding for another attempt.
	retry: {
		animation: MODE_SPINNERS.retry,
		tone: "warning",
	},
	// A stem that grows, then sprouts branches down its side.
	branchSummary: {
		animation: MODE_SPINNERS.branchSummary,
		tone: "mdLink",
	},
};

// Statuses added by future Pi versions still render, with a generic spinner.
const FALLBACK_STATUS_STYLE: StatusStyle = {
	animation: MODE_SPINNERS.fallback,
	tone: "accent",
};

// Wide enough that Pi's status text never wraps or truncates while it is read.
const INDICATOR_TEXT_WIDTH = 1_000;
const SEND_REFRESH_MS = 40;
const DISPLAY_REFRESH_MS = 200;
// An 80ms shared-grid poll sees every tenth without redrawing unchanged clocks.
const STEP_CLOCK_REFRESH_MS = 80;
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
}

interface StatusView {
	kind: StatusIndicator["kind"];
	spinner: string;
	elapsedMs: number;
	label: string;
	detail?: string;
	style: StatusStyle;
}

/** The call the model is writing now, with as much of its arguments as has streamed in. */
function latestToolCall(message: object): { name?: string; arguments?: unknown } | undefined {
	const content = "content" in message && Array.isArray(message.content) ? (message.content as { type?: string; name?: string; arguments?: unknown }[]) : [];
	return [...content].reverse().find((part) => part.type === "toolCall" && part.name);
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
	/** Tool Display's folded mode: no live thinking. */
	let folds = false;
	/** A folded line moves for what happens now, so the run line's spinner and word hold back. */
	let foldLive = false;
	let verb: RunLine["verb"];
	let verbs = parseVerbs(undefined);
	let reduced = false;
	let streamedChars = 0;
	let shownTokens = 0;
	let tokensAt = 0;
	let lastTokenAt = 0;
	let rate = { at: 0, chars: 0, rate: 0, waveMs: 0 };
	// The divider's TPS while a response streams; between responses it shows the prompt's average.
	let live: LiveRate | undefined;
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
	/** When the live thinking grew, so its new characters show brighter for a moment. */
	let thinkingTrail: Trail | undefined;
	let thoughtMs: number | undefined;
	let thoughtEndedAt = Number.NEGATIVE_INFINITY;
	let active = false;
	let metrics = emptyRunMetrics();
	let phase: ActivePhase = "prep";
	let stepKey = "prep";
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
	let pendingToolArgs: unknown;
	// Argument characters of the newest tool call; 0 while its provider holds them back.
	let callArgsChars = 0;
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
	/** Live thinking sits above queued messages; status always stays in the divider. */
	const tailRow = new TailRow();
	let linePaint: Paint | undefined;
	/** A compaction while it runs, drawn as a live band above the queue; its session and theme. */
	let compaction: LiveCompaction | undefined;
	let compactionSession: string | undefined;
	let compactionTheme: ExtensionContext["ui"]["theme"] | undefined;

	function compactionShown(now: number): boolean {
		if (compaction && !liveShown(compaction, now)) compaction = undefined;
		return compaction !== undefined;
	}

	function compactionTail(width: number): string[] {
		const now = performance.now();
		if (!compactionShown(now) || !compactionTheme) return [];
		return ["", ...liveCompactionLines(compaction!, width, compactionTheme as unknown as ThemeLike, now, reduced ? "reduced" : "full")];
	}

	/** The lines above Pi's queued messages: a running compaction, then the live thinking. */
	const drawTail = (width: number): string[] => [...compactionTail(width), ...drawThinkingTail(width)];

	function endCompaction(cancelled: boolean): void {
		compaction = cancelled && compaction ? cancelLive(compaction, performance.now()) : undefined;
		lastDrawing = undefined;
		activeTui?.requestRender();
	}

	/** Voice records in the top row only while this is false. */
	function announceBusy(): void {
		topBorder?.set(active || statusIndicator !== undefined || wave !== undefined);
	}

	function ensureTimer(): void {
		const now = performance.now();
		const status = statusView(now);
		if (!active && !status && !wave && !compactionShown(now)) { releaseTimer(); return; }
		const tools = leafTools();
		const peer = phase === "run" && tools.length > 0 && tools.every(tool => tool.blocking);
		const animation = status?.style.animation ?? MODE_SPINNERS[peer ? "peer" : phase];
		const cadence = spinnerCadence(animation, reduced, rate.rate, !!status && animation.kind === "fraction" && retryDelayMs !== undefined);
		const shimmer = reduced ? 1000 : !status && phase === "api" ? SEND_REFRESH_MS : DISPLAY_REFRESH_MS;
		// Yielding to a folded line, only the clock moves.
		const desired = wave ? PI_WAVE.stepMs : !status && foldLive ? STEP_CLOCK_REFRESH_MS : Math.ceil(Math.min(cadence, shimmer, STEP_CLOCK_REFRESH_MS));
		if (stopFrames && frameMs === desired) return;
		stopFrames?.();
		frameMs = desired;
		stopFrames = everyFrame(() => tick(), desired);
	}

	function releaseTimer(): void {
		if (!stopFrames || active || statusView(performance.now()) || wave || compactionShown(performance.now())) return;
		stopFrames();
		stopFrames = undefined;
	}

	/**
	 * Ends a status when Pi disposes its indicator. Pi tells only the editor it
	 * has mounted now; if another extension replaced ours meanwhile, the clear
	 * never reaches it, and the divider would show the status for good.
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
		return { kind: indicator.kind, spinner, elapsedMs, label, detail, style };
	}

	function visualState(now: number): VisualState {
		const elapsedMs = now - phaseStartedAt;
		if (phase !== "first_token") {
			return { phase, elapsedMs };
		}
		const wait = phaseAfterFirstTokenWait(elapsedMs);
		const visualPhase = wait.tone === "error" ? "stalled" : wait.tone === "warning" ? "slow_api" : "first_token";
		return { phase: visualPhase, elapsedMs };
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
			display: `${formatElapsed(state.elapsedMs)} ${state.phase}`,
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
		} else if (!statusIndicator && !wave && !compactionShown(now)) {
			releaseTimer();
			return;
		}
		if (!activeTui) return;
		const width = activeTui.terminal?.columns ?? 120;
		const drawing = drawTail(width).join("\n") + borderFingerprint(now, width);
		ensureTimer();
		if (drawing === lastDrawing) return;
		lastDrawing = drawing;
		activeTui?.requestRender();
	}

	function stepIdentity(next: ActivePhase): string {
		if (next === "tool") return `tool:${pendingToolName ?? "tool"}`;
		if (next !== "run") return next;
		const tools = leafTools();
		return tools.length > 1 ? `run:count:${tools.length}` : `run:name:${tools[0]?.name ?? "tool"}`;
	}

	function setPhase(next: ActivePhase, ctx: ExtensionContext, cause: string, forceLog = false, details?: Record<string, unknown>): void {
		const now = performance.now();
		const previousPhase = phase;
		const previousVisualPhase = visualState(now).phase;
		currentContext = ctx;
		const nextKey = stepIdentity(next);
		if (phase !== next || stepKey !== nextKey || cause === "before_provider_request" || cause === "toolcall_start") {
			if (phase === "think" && next !== "think") {
				thoughtMs = now - phaseStartedAt;
				thoughtEndedAt = now;
				liveThinking = "";
			}
			phase = next;
			stepKey = nextKey;
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
		stepKey = "prep";
		phaseStartedAt = now;
		renderedPhase = undefined;
		runningTools = new Map();
		pendingToolName = undefined;
		pendingToolArgs = undefined;
		if (!active) {
			lineStartedAt = now;
			runEnded = false;
			verb = verbs.length ? pickVerb(verbs) : undefined;
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
		const tps = averageTps(metrics);
		if (ctx.mode === "tui") pi.appendEntry(END_ENTRY, {
			...(verb ? { past: verb.past } : {}), elapsedMs: performance.now() - lineStartedAt,
			doneAt: new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }),
			...(stopped ? { stopped: true } : {}),
			...(tps !== undefined ? { tps } : {}),
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
		live = undefined;
		metrics = updateRunMetrics(metrics, { type: persistLastRun ? "settle" : "reset" });
		if (active && persistLastRun) lastTotalElapsedMs = performance.now() - agentStartedAt;
		else if (!persistLastRun) lastTotalElapsedMs = undefined;
		active = false;
		currentContext = undefined;
		runningTools = new Map();
		pendingToolName = undefined;
		pendingToolArgs = undefined;
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
			pendingTool: pendingToolName, pendingArgs: pendingToolArgs, thoughtMs, sinceThoughtMs: now - thoughtEndedAt,
			idleTokenMs: now - lastTokenAt, waveMs: rate.waveMs, tokensPerSecond: rate.rate, heldCall: phase === "tool" && callArgsChars === 0,
			...(foldLive ? { yields: true } : {}) };
	}

	function activeBorder(now: number, width: number, hiddenLineCount: number, paint: Paint): string {
		const model = runLine(now);
		const theme = currentContext!.ui.theme;
		return renderStatusDivider({
			status: renderRunStatus(model, theme),
			withoutTokens: renderRunStatus(model, theme, false),
			compactStatus: renderRunStatus(model, theme, false, true),
			elapsedMs: now - agentStartedAt,
			metrics,
			liveTps: liveTokensPerSecond(live, now),
			hiddenLineCount,
		}, width, paint("accent"));
	}

	function borderFingerprint(now: number, width: number): string {
		if (!linePaint) return "";
		if (wave) return waveBorder(now, width);
		const status = statusView(now);
		if (status) return statusBorder(status, now, width, 0, linePaint);
		if (active && currentContext) return activeBorder(now, width, 0, linePaint);
		return lastTotalElapsedMs === undefined ? "" : renderLastRunBorder(lastTotalElapsedMs, width, linePaint("accent"), 0, metrics);
	}

	function statusBorder(status: StatusView, now: number, width: number, hiddenLineCount: number, paint: Paint): string {
		// An idle status has no prompt total; only its left event clock belongs here.
		const colors = paint(status.style.tone);
		// Pi 0.99.2 owns retry countdown text. Do not put a second clock beside it.
		const countdown = status.kind === "retry" && /\bin\s+\d+(?:\.\d+)?s\b/.test(status.label);
		const clock = countdown ? "" : " " + colors.phase(formatElapsed(status.elapsedMs));
		const caption = colors.phase(status.spinner + " " + status.label) + clock + (status.detail ? colors.dim(" " + status.detail) : "");
		return renderStatusDivider({
			status: caption,
			withoutTokens: caption,
			elapsedMs: active ? now - agentStartedAt : undefined,
			metrics: active ? metrics : undefined,
			hiddenLineCount,
		}, width, colors);
	}

	/**
	 * Only live thinking belongs between the transcript and queued messages.
	 * The editor divider owns every status and sign-off animation.
	 */
	function drawThinkingTail(width: number): string[] {
		if (!linePaint || !active || runEnded || !currentContext || !hidesLiveThinking || folds || phase !== "think" || thinkingMode === "collapsed") return [];
		if (statusView(performance.now())) return [];
		const lines = thinkingTail(width, currentContext.ui.theme);
		return lines.length ? ["", ...lines] : [];
	}

	function thinkingTail(width: number, theme: ExtensionContext["ui"]["theme"]): string[] {
		const now = performance.now();
		// While new characters fade, each frame draws them dimmer; the cache holds once they have.
		if (!reduced && typeof theme.getFgAnsi === "function" && glowing(thinkingTrail, now)) return renderThinkingTail(liveThinking, width, theme, { trail: thinkingTrail, now });
		if (tailCache?.text === liveThinking && tailCache.width === width && tailCache.theme === theme) return tailCache.lines;
		const lines = renderThinkingTail(liveThinking, width, theme);
		tailCache = { text: liveThinking, width, theme, lines };
		return lines;
	}

	function waveBorder(now: number, width: number): string {
		if (!wave) return "";
		const glyph = renderPiWave(now - wave.at, wave.theme, width);
		return truncateToWidth(`─ ${glyph} ${wave.theme.fg("dim", "─".repeat(Math.max(0, width - 7)))}`, width, "");
	}

	function lastRunRow(lines: string[], width: number, paint: Paint, hiddenLineCount: number): string[] {
		// A recording borrows the idle row; the summary returns when it ends.
		if (lastTotalElapsedMs === undefined || topBorder?.peerActive) return lines;
		return [renderLastRunBorder(lastTotalElapsedMs, width, paint("accent"), hiddenLineCount, metrics), ...lines.slice(1)];
	}

	/**
	 * The editor divider owns status, metrics and the one elapsed clock.
	 * Voice uses the bottom border while this row is busy.
	 */
	function drawTopRow(lines: string[], width: number, paint: Paint, editor: WrappedEditor): string[] {
		// Pi draws the editor once it is mounted, so its place in Pi's layout is known by now.
		if (!tailRow.attached && activeTui) tailRow.attach(activeTui, editor, drawTail);
		const match = stripTerminalSequences(lines[0] ?? "").match(/↑\s*(\d+)/);
		const hiddenLineCount = match ? Number.parseInt(match[1] ?? "0", 10) : 0;
		const now = performance.now();
		if (wave && now - wave.at < PI_WAVE_MS) return [waveBorder(now, width), ...lines.slice(1)];
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
		foldLive = false;
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
		const settings = value as { motion?: unknown; thinking?: unknown; hidesLiveThinking?: unknown; folds?: unknown };
		if (settings?.motion !== undefined) reduced = settings.motion === "reduced";
		if (reduced) cancelWave();
		if (settings?.thinking !== undefined) thinkingMode = settings.thinking;
		if (typeof settings?.hidesLiveThinking === "boolean") hidesLiveThinking = settings.hidesLiveThinking;
		if (typeof settings?.folds === "boolean") folds = settings.folds;
		stopFrames?.();
		stopFrames = undefined;
		if (active || statusIndicator || wave) ensureTimer();
		tick();
	});
	pi.events?.on(FOLD_LIVE_EVENT, (value) => {
		const live = (value as { live?: unknown } | undefined)?.live === true;
		if (live === foldLive) return;
		foldLive = live;
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
	// Extensions' handlers run in load order, so this one starts the band before Cache Compaction's request.
	pi.on("session_before_compact", (event, ctx) => {
		if (event.reason === "overflow") continuationPending = true;
		const tokens = event.preparation?.tokensBefore;
		if (ctx.mode !== "tui" || typeof tokens !== "number") return;
		compaction = startLive(event.reason, tokens, performance.now());
		compactionSession = sessionIdOf(ctx);
		compactionTheme = ctx.ui.theme;
		ensureTimer();
	});
	pi.on("session_compact", () => endCompaction(false));
	pi.on("session_compact_failed", (event) => endCompaction(event.aborted === true));
	pi.events?.on(COMPACTION_PROGRESS_EVENT, (data) => {
		const progress = readProgress(data);
		if (!compaction || !progress || (compactionSession !== undefined && progress.sessionId !== compactionSession)) return;
		compaction = noteProgress(compaction, progress.text, progress.chars, performance.now());
	});
	pi.on("agent_start", (_event, ctx) => start(ctx));
	pi.on("turn_start", (_event, ctx) => setPhase("prep", ctx, "turn_start", true));
	pi.on("context", (_event, ctx) => setPhase("prep", ctx, "context", true));
	pi.on("before_provider_request", (_event, ctx) => {
		lastRequestAt = performance.now();
		lastTokenAt = lastRequestAt;
		metrics = updateRunMetrics(metrics, { type: "request", at: lastRequestAt });
		live = emptyLiveRate(lastRequestAt);
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
			if (live) live = noteArrival(live, lastTokenAt, streamEvent.delta.length);
		}
		metrics = updateRunMetrics(metrics, {
			type: "delta", at: performance.now(), kind: eventType,
			delta: "delta" in streamEvent ? streamEvent.delta : undefined,
		});
		if (eventType === "thinking_end") setPhase("prep", ctx, eventType);
		else if (eventType.startsWith("thinking_")) {
			const runs = thinkingRuns(event.message.content);
			liveThinking = runs.at(-1) ?? (liveThinking + ("delta" in streamEvent ? streamEvent.delta : ""));
			thinkingTrail = noteText(thinkingTrail, "thinking", liveThinking.length, performance.now());
			setPhase("think", ctx, eventType);
		}
		else if (eventType.startsWith("text_")) setPhase("text", ctx, eventType);
		else if (eventType.startsWith("toolcall_")) {
			if (eventType === "toolcall_start") callArgsChars = 0;
			else if (eventType === "toolcall_delta" && "delta" in streamEvent && typeof streamEvent.delta === "string") callArgsChars += streamEvent.delta.length;
			// A provider may send the arguments only in the call's end; after it, silence is a stall again.
			else if (eventType === "toolcall_end") callArgsChars = Math.max(callArgsChars, 1);
			const call = latestToolCall(event.message);
			pendingToolName = call?.name;
			pendingToolArgs = call?.arguments;
			setPhase("tool", ctx, eventType);
		}
	});
	pi.on("message_end", (event, ctx) => {
		if (event.message.role === "assistant") endReason = event.message.stopReason;
		if (event.message.role !== "assistant") return;
		live = undefined;
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
		compaction = undefined;
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
