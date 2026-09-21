import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { performance } from "node:perf_hooks";
import { join } from "node:path";
import {
	CustomEditor,
	keyText,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import {
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
	type AutocompleteProvider,
	type EditorComponent,
	type EditorTheme,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import {
	formatElapsed,
	phaseAfterFirstTokenWait,
	renderLastRunBorder,
	renderPhaseBorder,
	summarizeRunningTools,
	type PhaseAlertTone,
} from "../lib/phase-status.ts";

import { emptyRunMetrics, updateRunMetrics } from "../lib/phase-metrics.ts";

type ActivePhase = "prep" | "api" | "first_token" | "think" | "text" | "tool" | "run";
type VisualPhase = ActivePhase | "slow_api" | "stalled";
type ThemeTone = "dim" | "thinkingLow" | "accent" | "thinkingMedium" | "thinkingMinimal" | "mdHeading" | "toolOutput" | "warning" | "error";

interface PhaseStyle {
	label: string;
	tone: ThemeTone;
	frames: readonly string[];
	intervalMs: number;
}

const PHASE_STYLES: Record<VisualPhase, PhaseStyle> = {
	prep: {
		label: "Prep",
		tone: "dim",
		frames: ["⠁", "⠃", "⠇", "⠧", "⠷", "⠿", "⠷", "⠧", "⠇", "⠃"],
		intervalMs: 90,
	},
	api: {
		label: "API",
		tone: "thinkingLow",
		frames: ["⠁", "⠂", "⠄", "⡀", "⢀", "⠠", "⠐", "⠈"],
		intervalMs: 90,
	},
	first_token: {
		label: "Starting response",
		tone: "accent",
		frames: ["⠂", "⠆", "⠇", "⠧", "⠷", "⠿", "⠷", "⠧", "⠇", "⠆"],
		intervalMs: 150,
	},
	slow_api: {
		label: "Slow response",
		tone: "warning",
		frames: ["⠂", "⠆", "⠇", "⠧", "⠷", "⠿", "⠷", "⠧", "⠇", "⠆"],
		intervalMs: 190,
	},
	stalled: {
		label: "Stalled",
		tone: "error",
		frames: ["⠿", "⠷", "⠯", "⠟"],
		intervalMs: 300,
	},
	think: {
		label: "Think",
		tone: "thinkingMedium",
		frames: ["⠊", "⠑", "⠈", "⠁", "⠈", "⠑"],
		intervalMs: 120,
	},
	text: {
		label: "Text",
		tone: "thinkingMinimal",
		frames: ["⡀", "⡄", "⡆", "⡇", "⠇", "⠃", "⠁", "⠃", "⠇", "⡇", "⡆", "⡄"],
		intervalMs: 70,
	},
	tool: {
		label: "Tool",
		tone: "mdHeading",
		frames: ["⠈", "⠘", "⠸", "⠴", "⠦", "⠇", "⠃", "⠉"],
		intervalMs: 85,
	},
	run: {
		label: "Run",
		tone: "toolOutput",
		frames: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
		intervalMs: 80,
	},
};

const DISPLAY_REFRESH_MS = 100;
const DEBUG_HEARTBEAT_MS = 5_000;
const DEBUG_LOG = join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "phase-spinner-debug.jsonl");
const DEBUG_ENABLED = process.env.PHASE_SPINNER_DEBUG === "1";

interface VisualState {
	phase: VisualPhase;
	elapsedMs: number;
	style: PhaseStyle;
	alertTone: PhaseAlertTone;
}

function latestToolName(message: { content: readonly { type: string; name?: string }[] }): string | undefined {
	return [...message.content].reverse().find((part) => part.type === "toolCall" && part.name)?.name;
}

export default function phaseSpinner(pi: ExtensionAPI): void {
	let active = false;
	let metrics = emptyRunMetrics();
	let phase: ActivePhase = "prep";
	let phaseStartedAt = performance.now();
	let agentStartedAt = phaseStartedAt;
	let renderedPhase: VisualPhase | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let activeTui: TUI | undefined;
	let currentContext: ExtensionContext | undefined;
	let lastDebugAt = performance.now();
	let runningTools = new Map<string, string>();
	let pendingToolName: string | undefined;
	let lastTotalElapsedMs: number | undefined;
	let previousEditorFactory: ReturnType<ExtensionContext["ui"]["getEditorComponent"]>;
	let installedEditorFactory: ReturnType<ExtensionContext["ui"]["getEditorComponent"]>;

	function visualState(now: number): VisualState {
		const elapsedMs = now - phaseStartedAt;
		if (phase !== "first_token") {
			return { phase, elapsedMs, style: PHASE_STYLES[phase], alertTone: "phase" };
		}
		const wait = phaseAfterFirstTokenWait(elapsedMs);
		const visualPhase = wait.tone === "error" ? "stalled" : wait.tone === "warning" ? "slow_api" : "first_token";
		return { phase: visualPhase, elapsedMs, style: PHASE_STYLES[visualPhase], alertTone: wait.tone };
	}

	function phaseDetail(_ctx: ExtensionContext, state: VisualState): string | undefined {
		if (state.phase === "run") return summarizeRunningTools([...runningTools.values()]);
		if (state.phase === "tool") return pendingToolName;
		if (state.phase === "stalled") return `${keyText("app.interrupt")} abort`;
		return undefined;
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
		if (!active || !currentContext) return;
		const state = visualState(now);
		if (renderedPhase !== state.phase) {
			const previousVisualPhase = renderedPhase;
			renderedPhase = state.phase;
			debugState("visual_phase", currentContext, now, { previousVisualPhase });
		}
		if (now - lastDebugAt >= DEBUG_HEARTBEAT_MS) debugState("heartbeat", currentContext, now);
		activeTui?.requestRender();
	}

	function setPhase(next: ActivePhase, ctx: ExtensionContext, cause: string, forceLog = false, details?: Record<string, unknown>): void {
		const now = performance.now();
		const previousPhase = phase;
		const previousVisualPhase = visualState(now).phase;
		currentContext = ctx;
		if (phase !== next) {
			phase = next;
			phaseStartedAt = now;
			renderedPhase = undefined;
		}
		if (previousPhase !== phase || forceLog) {
			debugState(cause, ctx, now, { previousPhase, previousVisualPhase, ...details });
		}
		tick(now);
	}

	function start(ctx: ExtensionContext): void {
		const now = performance.now();
		metrics = updateRunMetrics(metrics, { type: "start" });
		currentContext = ctx;
		phase = "prep";
		phaseStartedAt = now;
		renderedPhase = undefined;
		runningTools = new Map();
		pendingToolName = undefined;
		if (!active) {
			active = true;
			agentStartedAt = now;
			lastDebugAt = now;
			if (timer) clearInterval(timer);
			timer = setInterval(() => tick(), DISPLAY_REFRESH_MS);
		}
		debugState("agent_start", ctx, now, { resumedActiveRun: active && agentStartedAt !== now });
		tick(now);
	}

	function stop(persistLastRun = false): void {
		metrics = updateRunMetrics(metrics, { type: persistLastRun ? "settle" : "reset" });
		if (active && persistLastRun) lastTotalElapsedMs = performance.now() - agentStartedAt;
		else if (!persistLastRun) lastTotalElapsedMs = undefined;
		active = false;
		currentContext = undefined;
		runningTools = new Map();
		pendingToolName = undefined;
		renderedPhase = undefined;
		if (timer) clearInterval(timer);
		timer = undefined;
		activeTui?.requestRender();
	}

	pi.on("session_start", (_event, ctx) => {
		stop();
		const currentFactory = ctx.ui.getEditorComponent();
		if (currentFactory !== installedEditorFactory) previousEditorFactory = currentFactory;
		const baseFactory = previousEditorFactory;

		class PhaseStatusEditor extends CustomEditor {
			private readonly base: EditorComponent;
			wantsKeyRelease?: boolean;

			constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, base: EditorComponent) {
				super(tui, theme, keybindings, { embedWorkingStatus: true });
				this.base = base;
				this.wantsKeyRelease = base.wantsKeyRelease;
				if (base instanceof CustomEditor) this.actionHandlers = base.actionHandlers;
				activeTui = tui;
			}

			private syncBase(): void {
				this.base.onSubmit = this.onSubmit;
				this.base.onChange = this.onChange;
				if (this.base.borderColor !== undefined) this.base.borderColor = this.borderColor;
				const focusable = this.base as EditorComponent & { focused?: boolean };
				if ("focused" in focusable) focusable.focused = this.focused;
				if (!(this.base instanceof CustomEditor)) return;
				this.base.actionHandlers = this.actionHandlers;
				this.base.onEscape = this.onEscape;
				this.base.onCtrlD = this.onCtrlD;
				this.base.onPasteImage = this.onPasteImage;
				this.base.onExtensionShortcut = this.onExtensionShortcut;
			}

			private activeBorder(width: number, hiddenLineCount: number): string {
				const now = performance.now();
				const state = visualState(now);
				const frameIndex = Math.floor(state.elapsedMs / state.style.intervalMs) % state.style.frames.length;
				const thm = currentContext?.ui.theme ?? ctx.ui.theme;
				return renderPhaseBorder({
					spinner: state.style.frames[frameIndex] ?? "⠿",
					phaseElapsedMs: state.elapsedMs,
					totalElapsedMs: now - agentStartedAt,
					metrics,
					label: state.style.label,
					detail: currentContext ? phaseDetail(currentContext, state) : undefined,
					tone: state.alertTone,
					hiddenLineCount,
				}, width, {
					border: (text) => this.borderColor(text),
					phase: (text) => thm.fg(state.style.tone, text),
					dim: (text) => thm.fg("dim", text),
					total: (text) => thm.fg("muted", text),
					warning: (text) => thm.fg("warning", text),
					error: (text) => thm.fg("error", text),
					measure: visibleWidth,
					truncate: (text, maxWidth) => truncateToWidth(text, maxWidth, ""),
				});
			}

			render(width: number): string[] {
				this.syncBase();
				const lines = this.base.render(width);
				if (lines.length === 0) return lines;
				const match = stripTerminalSequences(lines[0] ?? "").match(/↑\s*(\d+)/);
				const hiddenLineCount = match ? Number.parseInt(match[1] ?? "0", 10) : 0;
				if (active && currentContext) {
					return [this.activeBorder(width, hiddenLineCount), ...lines.slice(1)];
				}
				if (lastTotalElapsedMs === undefined) return lines;
				const thm = ctx.ui.theme;
				const completedBorder = renderLastRunBorder(lastTotalElapsedMs, width, {
					border: (text) => this.borderColor(text),
					phase: (text) => thm.fg("accent", text),
					dim: (text) => thm.fg("dim", text),
					total: (text) => thm.fg("muted", text),
					warning: (text) => thm.fg("warning", text),
					error: (text) => thm.fg("error", text),
					measure: visibleWidth,
					truncate: (text, maxWidth) => truncateToWidth(text, maxWidth, ""),
				}, hiddenLineCount, metrics);
				return [completedBorder, ...lines.slice(1)];
			}

			invalidate(): void {
				super.invalidate();
				this.base.invalidate();
			}

			handleInput(data: string): void {
				this.syncBase();
				this.base.handleInput(data);
			}

			handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
				this.syncBase();
				return this.base.handleMouse?.(event);
			}

			getText(): string { return this.base.getText(); }
			getExpandedText(): string { return this.base.getExpandedText?.() ?? this.base.getText(); }
			setText(text: string): void { this.syncBase(); this.base.setText(text); }
			addToHistory(text: string): void { this.base.addToHistory?.(text); }
			insertTextAtCursor(text: string): void { this.base.insertTextAtCursor?.(text); }
			setAutocompleteProvider(provider: AutocompleteProvider): void { this.base.setAutocompleteProvider?.(provider); }
			setPaddingX(padding: number): void { super.setPaddingX(padding); this.base.setPaddingX?.(padding); }
			setAutocompleteMaxVisible(maxVisible: number): void {
				super.setAutocompleteMaxVisible(maxVisible);
				this.base.setAutocompleteMaxVisible?.(maxVisible);
			}
		}

		installedEditorFactory = (tui, theme, keybindings) => {
			const base = baseFactory?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings);
			return new PhaseStatusEditor(tui, theme, keybindings, base);
		};
		ctx.ui.setEditorComponent(installedEditorFactory);
	});

	pi.on("agent_start", (_event, ctx) => start(ctx));
	pi.on("turn_start", (_event, ctx) => setPhase("prep", ctx, "turn_start", true));
	pi.on("context", (_event, ctx) => setPhase("prep", ctx, "context", true));
	pi.on("before_provider_request", (_event, ctx) => {
		metrics = updateRunMetrics(metrics, { type: "request", at: performance.now() });
		setPhase("api", ctx, "before_provider_request", true);
	});
	pi.on("after_provider_response", (event, ctx) => setPhase("first_token", ctx, "after_provider_response", true, { status: event.status }));
	pi.on("message_start", (event, ctx) => {
		if (event.message.role === "assistant") setPhase("first_token", ctx, "message_start", true);
	});
	pi.on("message_update", (event, ctx) => {
		const streamEvent = event.assistantMessageEvent;
		const eventType = streamEvent.type;
		metrics = updateRunMetrics(metrics, {
			type: "delta", at: performance.now(), kind: eventType,
			delta: "delta" in streamEvent ? streamEvent.delta : undefined,
		});
		if (eventType.startsWith("thinking_")) setPhase("think", ctx, eventType);
		else if (eventType.startsWith("text_")) setPhase("text", ctx, eventType);
		else if (eventType.startsWith("toolcall_")) {
			pendingToolName = latestToolName(event.message);
			setPhase("tool", ctx, eventType);
		}
	});
	pi.on("message_end", (event, ctx) => {
		if (event.message.role !== "assistant") return;
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
		runningTools = new Map(runningTools).set(event.toolCallId, event.toolName);
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
	pi.on("agent_end", (_event, ctx) => debugState("agent_end", ctx));
	pi.on("agent_settled", (_event, ctx) => {
		debugState("agent_settled", ctx);
		if (ctx.isIdle()) stop(true);
	});
	pi.on("session_shutdown", (_event, ctx) => {
		if (active) debugState("session_shutdown", ctx);
		stop();
		activeTui = undefined;
		if (ctx.ui.getEditorComponent() === installedEditorFactory) {
			ctx.ui.setEditorComponent(previousEditorFactory);
		}
		installedEditorFactory = undefined;
		previousEditorFactory = undefined;
	});
}
