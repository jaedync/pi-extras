/**
 * Folded mode for a session: finds Pi's transcript, draws it through a
 * FoldView, and keeps what the folded lines need (when each call ended, what
 * each reply thought) current from Pi's events. Tool Display owns the switch.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { findTranscript, FoldView, installFold, type FoldTheme, type NestedFact, type ReplyMessage } from "./transcript.ts";

export interface FoldDeps {
	enabled(): boolean;
	reduced(): boolean;
	busy(): boolean;
	now(): number;
	/** Calls `tick` on every frame until the returned function is called. */
	frames(tick: () => void): () => void;
	/** How long a reply thought, if known; `live`: with a run still going, its time so far. */
	thoughtMs(message: ReplyMessage, live?: boolean): number | undefined;
	/** The calls a script made inside a call, as Tool Display keeps them. */
	nestedOf(toolCallId: string): readonly NestedFact[] | undefined;
	/** The model has written this call of the reply it streams. */
	written?(toolCallId: string): boolean;
}

interface Tui {
	requestRender(): void;
	children?: unknown;
}

type Ui = ExtensionContext["ui"];
const PROBE = "pi-extras.fold-probe";

/**
 * The TUI, from a widget factory: Pi gives extensions no other handle on it.
 * The widget draws nothing and is taken down at once.
 */
function captureTui(ui: Ui): Tui | undefined {
	let tui: Tui | undefined;
	try {
		ui.setWidget(PROBE, (given) => {
			tui = given as unknown as Tui;
			return { render: () => [], invalidate() {} };
		}, { placement: "belowEditor" });
		ui.setWidget(PROBE, undefined);
	} catch {
		return undefined;
	}
	return tui;
}

type Entry = { type?: string; message?: { role?: string; toolCallId?: unknown; timestamp?: unknown } };

export interface Fold {
	foldsThinking(reply: object): boolean;
	expandsThinking(reply: object): boolean;
	/** The transcript is drawn folded: the switch is on and Pi's transcript was found. */
	active(): boolean;
	/** The switch changed, or the session started: put the view in place if it is on, draw again, and say whether it is active. */
	refresh(): boolean;
}

const FAILED = "Folded mode could not draw the transcript, so Pi's own rows show. Use /tool-display folded off, or /reload.";

export function watchFold(pi: Pick<ExtensionAPI, "on">, deps: FoldDeps): Fold {
	let ctx: ExtensionContext | undefined;
	let tui: Tui | undefined;
	let chat: { invalidate?: () => void } | undefined;
	let view: FoldView | undefined;
	let undo: (() => void) | undefined;
	let stopFrames: (() => void) | undefined;
	let warned = false;
	let ended = new Map<string, number>();

	const noteResult = (message: Entry["message"]) => {
		if (message?.role === "toolResult" && typeof message.toolCallId === "string" && typeof message.timestamp === "number") {
			ended = new Map(ended).set(message.toolCallId, message.timestamp);
		}
	};
	const loadBranch = (context: ExtensionContext) => {
		ended = new Map();
		for (const entry of (context.sessionManager?.getBranch?.() ?? []) as Entry[]) {
			if (entry.type === "message") noteResult(entry.message);
		}
	};
	const animate = (live: boolean) => {
		if (live && !stopFrames && tui) {
			const screen = tui;
			stopFrames = deps.frames(() => screen.requestRender());
		} else if (!live && stopFrames) {
			stopFrames();
			stopFrames = undefined;
		}
	};
	const failed = () => {
		animate(false);
		if (warned) return;
		warned = true;
		try { ctx?.ui.notify(FAILED, "warning"); } catch { /* The rows still show; only the note is lost. */ }
	};
	const stop = () => {
		animate(false);
		undo?.();
		undo = undefined;
		view = undefined;
		chat = undefined;
		tui = undefined;
	};
	/** Pi's transcript is found and patched only once folded mode is first on; until then nothing of Pi's is touched. */
	const install = () => {
		if (view || !ctx || ctx.mode !== "tui" || !deps.enabled()) return;
		const found = captureTui(ctx.ui);
		const transcript = findTranscript(found);
		if (!found || !transcript) return;
		tui = found;
		const host = ctx.ui as { theme?: FoldTheme };
		view = new FoldView({
			enabled: deps.enabled,
			theme: () => host.theme,
			busy: deps.busy,
			now: deps.now,
			reduced: deps.reduced,
			toolEndedAt: (id) => ended.get(id),
			thoughtMs: deps.thoughtMs,
			nestedOf: deps.nestedOf,
			...(deps.written ? { written: deps.written } : {}),
			animate,
			redraw: () => found.requestRender(),
		});
		chat = transcript as { invalidate?: () => void };
		undo = installFold(transcript, view, deps.enabled, failed);
	};

	pi.on("session_start", (_event, context) => {
		stop();
		ctx = context;
		warned = false;
		loadBranch(context);
	});
	pi.on("message_end", (event) => noteResult(event.message as Entry["message"]));
	pi.on("session_tree", (_event, context) => loadBranch(context));
	pi.on("session_compact", (_event, context) => loadBranch(context));
	pi.on("session_shutdown", () => {
		stop();
		ctx = undefined;
	});

	const active = () => view !== undefined && deps.enabled();
	return {
		foldsThinking: (reply) => view?.foldsThinking(reply) ?? false,
		expandsThinking: (reply) => view?.expandsThinking(reply) ?? false,
		active,
		refresh: () => {
			install();
			// Turning on needs no rebuild here: the view builds each reply again on its first frame.
			if (!deps.enabled()) {
				animate(false);
				try { chat?.invalidate?.(); } catch { /* The next rebuild of each reply catches up. */ }
			}
			tui?.requestRender();
			return active();
		},
	};
}
