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
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir, getPackageDir, VERSION, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { isChildSession } from "../lib/child-session.ts";
import { processBusy } from "../lib/idle-gc.ts";
import { errorText, operationalError } from "../lib/operational-log.ts";
import { registerSubcommand } from "../lib/pi-extras-command.ts";
import { BACKGROUND_EVENT, BACKGROUND_REQUEST_EVENT, backgroundWork } from "../lib/tab-status/events.ts";
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

export default function autoUpdate(pi: ExtensionAPI): void {
	// The smoke test loads this package in a throwaway Pi: no lease, no timers, no cycle from there.
	if (process.env.PI_EXTRAS_UPDATE_SMOKE === "1") return;
	const paths = storePaths(storeRootFrom(process.env, process.env.HOME || homedir()));
	const agentDir = getAgentDir();
	const log = fileLog(paths.log, Date.now);
	// Errors go to the agent dir's log, not the store: a user who never enabled auto-update gets no store.
	const errorLog = join(agentDir, "pi-extras.log");
	let session: UpdateSession | undefined;
	let ctx: ExtensionContext | undefined;
	let compacting = false;
	let removeSubcommand: (() => void) | undefined;
	let prompts = 0;
	const background = new Map<string, number>();

	const report = (what: string) => (error: unknown) => operationalError(errorLog, "auto-update", `${what}: ${errorText(error)}`);
	const spawn = (force: boolean) => spawnCycle(EXTRAS_DIR, force, report("could not start the update cycle"));

	// release-notes owns `/pi-extras`; this adds `/pi-extras update` to it. The table is shared by the
	// whole process, so only a main session adds it: a subagent's runtime must not take it over.
	const addSubcommand = () => registerSubcommand("update", {
		description: "Auto-update: status, now, rollback, pause, resume",
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
		ctx = context;
		compacting = false;
		prompts = 0;
		background.clear();
		// Subagents share the process: the main session alone leases, checks and moves.
		if (isChildSession(context.sessionManager)) return;
		removeSubcommand?.();
		removeSubcommand = addSubcommand();
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
				sessionFile: () => context.sessionManager.getSessionFile(),
				branch: () => context.sessionManager.getBranch() as never,
				appendEntry: (data) => pi.appendEntry<UpdateEntryData>(UPDATE_ENTRY, data),
				notify: (text, level) => context.ui.notify(text, level),
				setStatus: (text) => context.ui.setStatus(STATUS_KEY, text),
				signals: () => ({
					agentIdle: context.isIdle(),
					pendingMessages: context.hasPendingMessages(),
					compacting,
					promptOpen: prompts > 0,
					subagentRun: processBusy(),
					background: [...background.values()].some((count) => count > 0),
					editorEmpty: context.mode !== "tui" || context.ui.getEditorText().trim() === "",
				}),
				dispatchApply: () => pi.sendUserMessage(`/${APPLY_COMMAND}`, { expandPromptTemplates: true }),
				spawnCycle: spawn,
				restartToken: process.env.PI_EXTRAS_RESTART_TOKEN || undefined,
				updateNote,
				launchedByLauncher: process.env.PI_EXTRAS_LAUNCHER_PID === String(process.ppid),
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
	pi.on("user_bash", () => {
		active();
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

	pi.registerEntryRenderer<UpdateEntryData>(UPDATE_ENTRY, (entry, _options, theme) => {
		const text = typeof entry.data?.text === "string" ? entry.data.text : undefined;
		return text ? new Text(theme.fg("dim", text), 1, 0) : undefined;
	});
}
