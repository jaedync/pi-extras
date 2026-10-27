/**
 * auto-update: each main TUI or RPC session starts the update cycle on a
 * timer, shows what a cycle does in the status line, and moves to a new set
 * when it is idle (a reload for packages, a restart through the launcher for
 * Pi). Every session writes a lease, so GC keeps the releases it uses.
 * The logic is in lib/auto-update/session.ts; this file connects it to Pi.
 *
 * Off until `node lib/auto-update/cli.ts enable`. A session without the
 * store (state.json) writes nothing.
 */
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir, getMarkdownTheme, getPackageDir, keyHint, VERSION, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isChildSession } from "../lib/child-session.ts";
import { processBusy } from "../lib/idle-gc.ts";
import { errorText, operationalError } from "../lib/operational-log.ts";
import { registerSubcommand } from "../lib/pi-extras-command.ts";
import { BACKGROUND_EVENT, BACKGROUND_REQUEST_EVENT, backgroundWork } from "../lib/tab-status/events.ts";
import { type BashStart, type FocusView, selectorOpen, userBashRunning } from "../lib/auto-update/adopt.ts";
import { updateEntryView } from "../lib/auto-update/entry-view.ts";
import { parseChangelog, type NotesEntry } from "../lib/release-notes.ts";
import { launcherEnv } from "../lib/auto-update/launcher-env.ts";
import { fileLog } from "../lib/auto-update/log.ts";
import { EXTRAS_DIR, storePaths, storeRootFrom } from "../lib/auto-update/paths.ts";
import { APPLY_COMMAND, STATUS_KEY, UPDATE_ENTRY, UpdateSession, type UpdateEntryData } from "../lib/auto-update/session.ts";
import { spawnCycle } from "../lib/auto-update/spawn.ts";
import { updateCommand } from "../lib/auto-update/slash.ts";

function realOr(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		// A folder that went away: the path still names it in the lease.
		return path;
	}
}

/** Where this process loaded code from: pi-extras itself, and the source of each tool and command. */
function loadedPaths(pi: ExtensionAPI): string[] {
	let items: { sourceInfo?: { path?: unknown } }[];
	try {
		items = [...pi.getAllTools(), ...pi.getCommands()];
	} catch {
		// A Pi without these lists: pi-extras' own folder, then the settings snapshot for the rest.
		items = [];
	}
	const sources = items.map((item) => item.sourceInfo?.path).filter((path): path is string => typeof path === "string" && path.startsWith("/"));
	return [...new Set([EXTRAS_DIR, ...sources])].map(realOr);
}

const FOCUS_WIDGET = "pi-extras-auto-update-focus";

/** The version of this copy: a reload loads the new copy, so the "done" entry names the version moved to. */
function extrasVersion(): string {
	try {
		const version = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown }).version;
		return typeof version === "string" ? version : "";
	} catch {
		return "";
	}
}

let notes: NotesEntry[] | undefined;
/** Read once per module: the renderer runs again at each resize and expand. */
function changelog(): NotesEntry[] {
	notes ??= parseChangelog(readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8"));
	return notes;
}
/** Versioned: a later pi-extras that keeps other data here picks a new symbol. */
const HISTORY = Symbol.for("pi-extras.auto-update.loaded-releases.v1");

/** One set per process, on globalThis: each reload loads this module again, and the set must outlive it. */
function processHistory(): Set<string> {
	const slot = globalThis as { [HISTORY]?: Set<string> };
	return (slot[HISTORY] ??= new Set());
}

export default function autoUpdate(pi: ExtensionAPI): void {
	// The smoke test loads this package in a throwaway Pi: no lease, no timers, no cycle from there.
	if (process.env.PI_EXTRAS_UPDATE_SMOKE === "1") return;
	const launcher = launcherEnv(process.env);
	// Real paths, as the CLI writes them into settings.json; resolved again at each session start, since the store may appear later.
	const storeRoot = () => storePaths(realOr(storeRootFrom(process.env, process.env.HOME || homedir())));
	let paths = storeRoot();
	const agentDir = getAgentDir();
	const log = (line: string) => fileLog(paths.log, Date.now)(line);
	// Errors go to the agent dir's log, not the store: a user who never enabled auto-update gets no store.
	const errorLog = join(agentDir, "pi-extras.log");
	let session: UpdateSession | undefined;
	let ctx: ExtensionContext | undefined;
	let compacting = false;
	let removeSubcommand: (() => void) | undefined;
	let prompts = 0;
	let bashStarts: BashStart[] = [];
	let tui: FocusView | undefined;
	const background = new Map<string, number>();

	/** True while a user `!` command runs. The starts are kept until all have ended: an end matches the oldest open start. */
	const bashRunning = (context: ExtensionContext): boolean => {
		if (bashStarts.length === 0) return false;
		const running = userBashRunning(bashStarts, context.sessionManager.getBranch() as never, Date.now());
		if (!running) bashStarts = [];
		return running;
	};
	const report = (what: string) => (error: unknown) => operationalError(errorLog, "auto-update", `${what}: ${errorText(error)}`);
	const spawn = (force: boolean) => spawnCycle(EXTRAS_DIR, paths.root, force, report("could not start the update cycle"));

	// release-notes owns `/pi-extras`; this adds `/pi-extras update` to it. The table is shared by the
	// whole process, so only a main session adds it: a subagent's runtime must not take it over.
	const addSubcommand = () => registerSubcommand("update", {
		description: "Auto-update: status, now, retry, rollback, pause, resume",
		handler: async (args, context) => {
			const result = updateCommand(args, {
				paths, agentDir, extrasDir: EXTRAS_DIR, now: Date.now, log,
				pending: () => {
					const decision = session?.decision();
					return decision && decision.kind !== "none" ? (decision.kind === "wait" ? "waits for the update to finish" : decision.text) : undefined;
				},
				spawnCycle: () => spawn(true),
			});
			context.ui.notify(result.lines.join("\n"), result.level);
		},
	});

	pi.on("session_start", (event, context) => {
		session?.stop("reload");
		session = undefined;
		paths = storeRoot();
		ctx = context;
		compacting = false;
		prompts = 0;
		bashStarts = [];
		background.clear();
		// Subagents share the process: the main session alone leases, checks and moves.
		if (isChildSession(context.sessionManager)) return;
		removeSubcommand?.();
		removeSubcommand = addSubcommand();
		tui = undefined;
		if (context.mode === "tui") {
			// A zero-row widget is the public way to reach the TUI: it tells when a built-in selector has the focus.
			context.ui.setWidget(FOCUS_WIDGET, (view) => {
				tui = view as unknown as FocusView;
				return { render: () => [], invalidate() {} };
			});
		}
		// The launcher's note is for the first main session of this process only: a later reload must not repeat it.
		const updateNote = process.env.PI_EXTRAS_UPDATE_DONE || undefined;
		delete process.env.PI_EXTRAS_UPDATE_DONE;
		try {
			session = new UpdateSession({
				mode: context.mode,
				paths,
				agentDir,
				piVersion: VERSION,
				piDir: realOr(getPackageDir()),
				extrasDir: EXTRAS_DIR,
				extrasVersion: extrasVersion(),
				sessionFile: () => context.sessionManager.getSessionFile(),
				argv: process.argv.slice(2),
				restarted: launcher.restarted,
				loadedPaths: () => loadedPaths(pi),
				history: processHistory(),
				branch: () => context.sessionManager.getBranch() as never,
				appendEntry: (data) => pi.appendEntry<UpdateEntryData>(UPDATE_ENTRY, data),
				notify: (text, level) => context.ui.notify(text, level),
				setStatus: (text) => context.ui.setStatus(STATUS_KEY, text),
				signals: () => ({
					agentIdle: context.isIdle(),
					pendingMessages: context.hasPendingMessages(),
					compacting,
					promptOpen: prompts > 0 || selectorOpen(tui),
					subagentRun: processBusy(),
					background: [...background.values()].some((count) => count > 0),
					editorEmpty: context.mode !== "tui" || context.ui.getEditorText().trim() === "",
					userBash: bashRunning(context),
				}),
				dispatchApply: () => pi.sendUserMessage(`/${APPLY_COMMAND}`, { expandPromptTemplates: true }),
				spawnCycle: spawn,
				restartToken: launcher.token,
				updateNote,
				launchedByLauncher: launcher.launchedByLauncher,
				now: Date.now,
				random: Math.random,
				setTimer: (fn, ms) => {
					// Unref'd: a timer never keeps a finished Pi from exiting.
					const handle = setInterval(() => {
						try {
							fn();
						} catch (error) {
							report("timer failed")(error);
						}
					}, ms).unref();
					return () => clearInterval(handle);
				},
			});
			session.start(event.reason);
		} catch (error) {
			// Fail-open: the session runs without auto-update, and the log says why.
			session = undefined;
			report("could not start")(error);
		}
		// Shell jobs and subagents publish their counts on request.
		pi.events?.emit(BACKGROUND_REQUEST_EVENT, { sessionId: context.sessionManager.getSessionId() });
	});

	pi.events?.on(BACKGROUND_EVENT, (payload) => {
		const value = backgroundWork(payload);
		if (value && value.sessionId === ctx?.sessionManager.getSessionId()) background.set(value.source, value.count);
	});
	pi.on("session_before_compact", () => {
		compacting = true;
	});
	pi.on("session_compact", () => {
		compacting = false;
	});
	pi.on("session_compact_failed", () => {
		compacting = false;
	});
	pi.on("ui_prompt_start", () => {
		prompts++;
	});
	pi.on("ui_prompt_end", () => {
		prompts = Math.max(0, prompts - 1);
		active();
	});
	// User or agent activity: a move waits 30 s after the last one.
	const active = () => session?.activity();
	pi.on("input", () => {
		active();
	});
	pi.on("user_bash", (event) => {
		active();
		bashStarts.push({ command: event.command, at: Date.now() });
	});
	pi.on("agent_start", active);
	pi.on("turn_start", active);
	pi.on("tool_execution_start", active);
	pi.on("model_select", active);
	// A run just ended: the soonest a reload can fit, once the quiet time has passed.
	pi.on("agent_end", () => {
		active();
		try {
			session?.poll();
		} catch (error) {
			report("poll failed")(error);
		}
	});
	pi.on("session_shutdown", (event) => {
		if (session && tui) {
			try {
				ctx?.ui.setWidget(FOCUS_WIDGET, undefined);
			} catch {
				// A context that went stale with its session.
			}
		}
		tui = undefined;
		session?.stop(event.reason);
		session = undefined;
		ctx = undefined;
		removeSubcommand?.();
		removeSubcommand = undefined;
	});

	pi.registerCommand(APPLY_COMMAND, {
		description: "Internal: move this session to the new pi-extras set (auto-update)",
		handler: async (_args, context) => {
			await session?.apply({ reload: () => context.reload(), shutdown: () => context.shutdown() });
		},
	});

	pi.registerEntryRenderer<UpdateEntryData>(UPDATE_ENTRY, (entry, options, theme) => updateEntryView(entry.data, {
		expanded: options.expanded,
		theme,
		markdownTheme: getMarkdownTheme(),
		changelog,
		at: entry.timestamp,
		hint: (description) => {
			try {
				return keyHint("app.tools.expand", description);
			} catch {
				return theme.fg("dim", `ctrl+o ${description}`);
			}
		},
	}));
}
