/** Terminal tab metadata only. Conversation state comes from Pi, not the phase widget. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { colorToHex, type Terminal } from "@earendil-works/pi-tui";
import { readSection } from "../lib/extras-config.ts";
import { callPhrase } from "../lib/tool-phrase.ts";
import { initialState, loadSettings, passthrough, progressSequence, shouldRun, statusSequence, terminalSupport, transition, view, type Action, type Settings } from "../lib/tab-status/core.ts";
import { terminalFamily } from "../lib/tab-status/terminal.ts";
import { remember, take, forget } from "../lib/tab-status/handoff.ts";
import { BACKGROUND_EVENT, BACKGROUND_REQUEST_EVENT, RATE_WAIT_EVENT, backgroundWork, rateWait } from "../lib/tab-status/events.ts";

export interface TabStatusOptions {
	readonly env?: NodeJS.ProcessEnv;
	readonly isTTY?: () => boolean;
	readonly settings?: Record<string, unknown>;
	readonly idleDelayMs?: number;
}

const KEEPALIVE_MS = 1000;
const IDLE_DELAY_MS = 1500;
const WIDGET = "tab-status-terminal";
const CLEAR_STATUS = statusSequence();

export default function tabStatus(pi: ExtensionAPI, options: TabStatusOptions = {}): void {
	const env = options.env ?? process.env;
	const progressBytes = (value: Parameters<typeof progressSequence>[0]) => progressSequence(value, terminalFamily(env) === "windows-terminal");
	let state = initialState();
	let ctx: ExtensionContext | undefined;
	let terminal: Pick<Terminal, "write"> | undefined;
	let settings: Settings = loadSettings({});
	let sessionStatus = false, progress = false;
	let last = "";
	let timer: ReturnType<typeof setInterval> | undefined;
	let stopped = true;
	let sessionKey: object | undefined, sessionId = "";
	let ownedStatus = false, ownedProgress = false;
	let idleTimer: ReturnType<typeof setTimeout> | undefined;
	let idleRepeat: ReturnType<typeof setTimeout> | undefined;

	const outputs = (candidate: Settings) => {
		const supported = terminalSupport(env);
		return {
			sessionStatus: candidate.enabled && terminalFamily(env) === "iterm2" && (candidate.sessionStatus === "auto" ? supported.sessionStatus : candidate.sessionStatus),
			progress: candidate.enabled && (candidate.progress === "auto" ? supported.progress : candidate.progress),
		};
	};
	const stopTimer = () => { if (timer) clearInterval(timer); timer = undefined; };
	const cancelIdle = () => {
		if (idleTimer) clearTimeout(idleTimer);
		if (idleRepeat) clearTimeout(idleRepeat);
		idleTimer = undefined; idleRepeat = undefined;
	};
	const write = (status: string, bar: string, target = { sessionStatus, progress }) => {
		const statusBytes = target.sessionStatus && status ? passthrough(status, !!env.TMUX) : "";
		const barBytes = target.progress && bar && !pi.getSettings().terminal?.showTerminalProgress ? passthrough(bar, !!env.TMUX) : "";
		// Pi's frames are synchronous. Event handlers and timers call the same terminal outside render().
		if (terminal && (statusBytes || barBytes)) {
			terminal.write(statusBytes + barBytes);
			if (statusBytes) ownedStatus = status !== CLEAR_STATUS;
			// Zero is still our last progress write, so retain ownership until explicit cleanup.
			if (barBytes) ownedProgress = true;
		}
	};
	const publish = (keepalive = false, idleReady = false) => {
		if (stopped || !ctx || !terminal) return;
		const c = ctx.ui.theme.colors;
		const colors = { accent: colorToHex(c.accent), warning: colorToHex(c.warning), dim: colorToHex(c.dim), error: colorToHex(c.error) };
		const shown = view(state, colors, settings.busyWhileBackground, settings.detail);
		const status = statusSequence(shown);
		const bar = progressBytes(shown.progress === 4 && terminalFamily(env) === "wezterm" ? 3 : shown.progress);
		const signature = status + bar;
		// Reloaded sources report their counts after session_start. Do not briefly announce idle.
		if (shown.status === "idle" && signature !== last && !idleReady) {
			idleTimer ??= setTimeout(() => { idleTimer = undefined; refresh(false, true); }, options.idleDelayMs ?? IDLE_DELAY_MS);
			idleTimer.unref();
			return;
		}
		if (shown.status !== "idle") cancelIdle();
		if (signature !== last) {
			write(status, bar); last = signature;
			if (env.TMUX && shown.status === "idle") {
				if (idleRepeat) clearTimeout(idleRepeat);
				idleRepeat = setTimeout(() => { idleRepeat = undefined; refresh(true, true); }, KEEPALIVE_MS);
				idleRepeat.unref();
			}
		} else if (keepalive && (shown.progress !== 0 || env.TMUX)) write(env.TMUX ? status : "", bar);
		if ((progress && shown.progress !== 0) || (sessionStatus && shown.status !== "idle")) {
			timer ??= setInterval(() => refresh(true), KEEPALIVE_MS);
			timer.unref();
		} else stopTimer();
	};
	const disableUpdates = () => {
		stopped = true; stopTimer(); cancelIdle();
		try { ctx?.ui.notify("Tab Status could not update the terminal. Reload Pi to retry.", "warning"); }
		catch { /* The UI may be disposed. Updates are already disabled; no console fallback may corrupt frames. */ }
	};
	const refresh = (keepalive = false, idleReady = false) => {
		try { publish(keepalive, idleReady); }
		catch { disableUpdates(); }
	};
	const apply = (action: Action) => { if (!stopped) { state = transition(state, action); refresh(); } };

	pi.events.on(BACKGROUND_EVENT, (payload) => {
		const value = backgroundWork(payload);
		if (value && value.sessionId === ctx?.sessionManager.getSessionId()) apply({ type: "background", source: value.source, count: value.count });
	});
	pi.events.on(RATE_WAIT_EVENT, (payload) => {
		const value = rateWait(payload);
		if (value && value.sessionId === ctx?.sessionManager.getSessionId()) apply({ type: "rateWait", active: value.active });
	});

	const attach = (context: ExtensionContext) => {
		ctx = context;
		// A zero-row widget gives us the public TUI terminal without opening a blocking dialog.
		context.ui.setWidget(WIDGET, (tui) => {
			terminal = tui.terminal;
			return { render: () => [], invalidate() { queueMicrotask(() => refresh()); } };
		});
	};
	const detach = () => { ctx?.ui.setWidget(WIDGET, undefined); terminal = undefined; ctx = undefined; };
	pi.on("session_start", (_event, context) => {
		stopTimer(); cancelIdle(); stopped = true; terminal = undefined; ctx = undefined; last = "";
		ownedStatus = false; ownedProgress = false;
		settings = loadSettings(options.settings ?? readSection("tabStatus"));
		sessionKey = context.sessionManager; sessionId = context.sessionManager.getSessionId();
		if (!shouldRun(context, options.isTTY?.() ?? !!process.stdout.isTTY)) return;
		const previous = take(sessionKey, sessionId);
		({ sessionStatus, progress } = outputs(settings));
		if (!sessionStatus && !progress && !previous) return;
		ownedStatus = previous?.sessionStatus ?? false; ownedProgress = previous?.progress ?? false;
		attach(context);
		try { write(CLEAR_STATUS, progressBytes(0), { sessionStatus: !!previous?.sessionStatus && !sessionStatus, progress: !!previous?.progress && !progress }); }
		catch { disableUpdates(); return; }
		if (!sessionStatus) ownedStatus = false;
		if (!progress) ownedProgress = false;
		if (!sessionStatus && !progress) { detach(); return; }
		state = initialState();
		const assistant = settings.detail === "reply" ? context.sessionManager.getBranch().filter((e) => e.type === "message" && e.message.role === "assistant").at(-1) : undefined;
		if (assistant?.type === "message" && assistant.message.role === "assistant") {
			state = transition(state, { type: "message", text: assistant.message.content.filter((b) => b.type === "text").map((b) => b.text).join("\n"), error: assistant.message.stopReason === "error" ? assistant.message.errorMessage ?? "Turn failed" : undefined });
		}
		if (!context.isIdle()) state = transition(state, { type: "begin" });
		stopped = false; refresh();
		pi.events.emit(BACKGROUND_REQUEST_EVENT, { sessionId: context.sessionManager.getSessionId() });
	});
	pi.on("agent_start", () => apply({ type: "begin" }));
	pi.on("context", () => apply({ type: "phase", text: "thinking" }));
	pi.on("message_update", (event) => {
		if (event.message.role !== "assistant") return;
		const update = event.assistantMessageEvent;
		const block = "contentIndex" in update ? event.message.content[update.contentIndex] : undefined;
		apply({ type: "phase", text: update.type.startsWith("toolcall") && block?.type === "toolCall" ? callPhrase(block.name, block.arguments) : update.type.startsWith("text") ? "writing" : "thinking" });
	});
	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant") return;
		apply({ type: "message", text: settings.detail === "reply" ? event.message.content.filter((b) => b.type === "text").map((b) => b.text).join("\n") : "", error: event.message.stopReason === "error" ? event.message.errorMessage ?? "Turn failed" : undefined });
	});
	pi.on("tool_execution_start", (event) => apply({ type: "toolStart", id: event.toolCallId, name: event.toolName }));
	pi.on("tool_execution_end", (event) => apply({ type: "toolEnd", id: event.toolCallId }));
	pi.on("ui_prompt_start", (event) => apply({ type: "dialogStart", title: event.title }));
	pi.on("ui_prompt_end", () => apply({ type: "dialogEnd" }));
	pi.on("session_before_compact", () => apply({ type: "compactStart" }));
	pi.on("session_compact", (event) => apply({ type: "compactEnd", retry: event.willRetry }));
	pi.on("session_compact_failed", (event) => {
		if (event.reason !== "manual" && !event.aborted && event.errorMessage) apply({ type: "message", text: "", error: event.errorMessage });
		apply({ type: "compactEnd", retry: false });
	});
	pi.on("agent_settled", () => apply({ type: "settled" }));
	pi.on("session_shutdown", (event) => {
		if (event.reason !== "reload" && sessionKey) forget(sessionKey, sessionId);
		if (!ctx || !terminal) return;
		stopped = true; stopTimer(); cancelIdle();
		if (event.reason === "reload" && sessionKey) {
			const handoff = { sessionId, sessionStatus: ownedStatus, progress: ownedProgress && !pi.getSettings().terminal?.showTerminalProgress };
			if (handoff.sessionStatus || handoff.progress) remember(sessionKey, handoff);
		} else {
			try { write(CLEAR_STATUS, progressBytes(0), { sessionStatus: ownedStatus, progress: ownedProgress }); }
			catch { ctx.ui.notify("Tab Status could not clear the terminal. The next start will reset it.", "warning"); }
		}
		detach();
	});
}
