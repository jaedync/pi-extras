/**
 * Auto-update inside one Pi process: the lease, the timers that start a
 * cycle, the status line, and adoption (reload or restart when idle). All
 * Pi access goes through `SessionHost`, so tests drive it with fakes.
 */
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decide, fingerprint, idleFor, packagesDiffer, piDiffers, type Decision, type IdleSignals, type OwnSet } from "./adopt.ts";
import { isLockHeld } from "../file-lock.ts";
import { readConfig, type AutoUpdateConfig } from "./config.ts";
import { LOCK_STALE_MS } from "./cycle.ts";
import { processStart, removeLease, writeLease } from "./leases.ts";
import { loadedEntries } from "./own-set.ts";
import { replayArgs } from "./replay.ts";
import { isInside, type StorePaths } from "./paths.ts";
import { readSettingsPackages, settingsFile } from "./settings.ts";
import { classify, entrySource } from "./sources.ts";
import { readState, type UpdateState } from "./state.ts";
import { clearRestart, markRestart } from "../restart-intent.ts";
import { piCurrentMatches, settingsMatch } from "./switch.ts";

export const UPDATE_ENTRY = "pi-extras-update";
export const APPLY_COMMAND = "pi-extras-update-apply";
export const STATUS_KEY = "auto-update";
export const POLL_MS = 15_000;
/**
 * A reload that has not ended after this long is stuck: Pi awaits each
 * extension's session_shutdown handler with no time limit, so one handler that
 * never ends holds the reload (and the "Reloading" box) forever.
 */
export const RELOAD_STUCK_MS = 60_000;
/** After the watchdog asked Pi to quit: a Pi still alive this long later is stuck in its own quit. */
export const SHUTDOWN_STUCK_MS = 30_000;
const STUCK_RESTART = `The update reload did not finish in ${RELOAD_STUCK_MS / 1000} s. An extension's shutdown step does not end. Pi restarts with this session.`;
const STUCK_QUIT = `The update reload did not finish in ${RELOAD_STUCK_MS / 1000} s. An extension's shutdown step does not end. Quit Pi and start it again.`;
export const LAUNCHER_WARNING = "auto-update: ~/.local/bin/pi was replaced; run enable again, or disable";
/** An activity older than this belongs to a cycle that stopped without clearing it. */
const ACTIVITY_MAX_AGE_MS = 15 * 60_000;
/** A ready move that waits this long for idle tells the user, who can move by hand. */
export const LONG_WAIT_MS = 30 * 60_000;
const LONG_WAIT_TEXT = { reload: "update ready: waits for idle (/reload to use it)", restart: "update ready: waits for idle (restart to use it)" } as const;
const JITTER = 0.2;

export interface UpdateEntryData {
	readonly phase: "start" | "done";
	readonly target: string;
	readonly text: string;
	/** For "start": what to say once the session runs the target. */
	readonly after?: string;
	/** For "start": the pi-extras version that made the move. */
	readonly from?: string;
	/** For "done": the pi-extras versions whose notes the entry shows when expanded. */
	readonly extras?: { readonly from: string; readonly to: string };
}

/** "Updating pi-extras 0.29.0 -> 0.30.0: ..." from pi-extras 0.31.1 and older, which wrote no `from`. */
const OLD_FROM = /pi-extras (\d+\.\d+\.\d+) (?:->|→) /;

/** What the controller needs from Pi and the machine. */
export interface SessionHost {
	readonly mode: string;
	readonly paths: StorePaths;
	readonly agentDir: string;
	readonly piVersion: string;
	readonly piDir: string;
	readonly extrasDir: string;
	/** The version of the pi-extras code that runs this controller. */
	readonly extrasVersion: string;
	readonly sessionFile: () => string | undefined;
	/** Pi's own arguments (process.argv after the script): a restart repeats the safe ones. */
	readonly argv: readonly string[];
	/** From the launcher: how often in a row it restarted Pi for `target` (PI_EXTRAS_RESTART_COUNT and _TARGET). */
	readonly restarted: { readonly count: number; readonly target: string } | undefined;
	/** Real paths of the code this process loaded: pi-extras itself and the sources of tools and commands. */
	readonly loadedPaths: () => readonly string[];
	/**
	 * Every store release this process loaded, across reloads. Old code keeps
	 * running after a reload (parked runtimes, timers, late imports), so the
	 * lease names all of them until the process quits.
	 */
	readonly history: Set<string>;
	readonly branch: () => readonly { type: string; customType?: string; data?: unknown }[];
	readonly appendEntry: (data: UpdateEntryData) => void;
	readonly notify: (text: string, level: "info" | "warning") => void;
	readonly setStatus: (text: string | undefined) => void;
	readonly signals: () => Omit<IdleSignals, "now" | "lastActivityAt">;
	readonly dispatchApply: () => void;
	readonly spawnCycle: (force: boolean) => void;
	readonly restartToken: string | undefined;
	/**
	 * The "Updated" line the launcher passes to a Pi that it started again
	 * (`PI_EXTRAS_UPDATE_DONE`). Pi writes a session file only after the first
	 * reply, so a restarted new session has no "start" entry to read it from.
	 */
	readonly updateNote: string | undefined;
	/** True when the launcher is this process's parent. */
	readonly launchedByLauncher: boolean;
	readonly now: () => number;
	readonly random: () => number;
	/** A repeating, unref'd timer; returns its stop. */
	readonly setTimer: (fn: () => void, ms: number) => () => void;
	/** A one-shot, unref'd timer; returns its stop. */
	readonly setOnce: (fn: () => void, ms: number) => () => void;
	/** One line in update.log. */
	readonly log: (line: string) => void;
	/** Ends the process at once (process.exit): the last step when Pi's own quit hangs. */
	readonly exit: (code: number) => void;
}

function realOr(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

/** Store entries in settings.json now: the fallback for a package that registers no tool or command. */
function storeEntries(host: SessionHost): string[] {
	let packages: unknown[];
	try {
		packages = readSettingsPackages(settingsFile(host.agentDir));
	} catch {
		// A broken settings.json: Pi itself loaded no packages from it either.
		return [];
	}
	return packages.map(entrySource).filter((source): source is string => source !== undefined && classify(source, host.paths.root).kind === "store");
}

function safeState(paths: StorePaths): UpdateState | undefined {
	try {
		return readState(paths.state);
	} catch {
		// A state this code cannot read: the cycle reports it; sessions keep running as they are.
		return undefined;
	}
}

function undoRestart(request: string): void {
	clearRestart();
	rmSync(request, { force: true });
}

export class UpdateSession {
	private readonly host: SessionHost;
	private own: OwnSet;
	private lastActivityAt: number;
	private stops: (() => void)[] = [];
	private stopped = false;
	private lastStatus: string | undefined;
	private launcherNoticeShown = false;
	/** Since when a reload or restart to `target` waits for idle. */
	private waiting: { readonly target: string; readonly since: number } | undefined;

	constructor(host: SessionHost) {
		this.host = host;
		this.lastActivityAt = host.now();
		const state = safeState(host.paths);
		const known = [state?.current, state?.previous].flatMap((set) => (set ? Object.values(set.packages) : []));
		const entries = loadedEntries({ storeRoot: host.paths.root, snapshot: storeEntries(host), loadedPaths: host.loadedPaths(), known });
		this.own = { piVersion: host.piVersion, piDir: host.piDir, entries };
	}

	private config(): AutoUpdateConfig {
		return readConfig(this.host.agentDir);
	}

	/** Leases exist only once the store does: a user who never enabled auto-update gets no files. */
	private storeInUse(): boolean {
		return existsSync(this.host.paths.state);
	}

	writeLease(): void {
		if (!this.storeInUse()) return;
		const start = processStart(process.pid);
		if (start === undefined) return;
		const extras = realOr(this.host.extrasDir);
		for (const entry of [...this.own.entries, ...(isInside(extras, this.host.paths.root) ? [extras] : [])]) this.host.history.add(entry);
		const releases = [...this.host.history];
		writeLease(this.host.paths, { pid: process.pid, start, piVersion: this.host.piVersion, piDir: this.host.piDir, releases, extrasDir: extras, mode: this.host.mode, sessionFile: this.host.sessionFile(), updatedAt: this.host.now() });
	}

	removeLease(): void {
		const start = processStart(process.pid);
		if (start !== undefined) removeLease(this.host.paths, { pid: process.pid, start });
	}

	/** Session start: the "Updated" line after an adoption, then the timers (TUI and RPC only). */
	start(reason: string): void {
		this.writeLease();
		this.reportAdoption();
		if (this.host.mode !== "tui" && this.host.mode !== "rpc") return;
		if (!this.config().enabled) return;
		this.stops.push(this.host.setTimer(() => this.poll(), POLL_MS));
		this.scheduleCycle();
		if (reason === "startup") this.maybeSpawn();
		this.poll();
	}

	stop(reason: string): void {
		this.stopped = true;
		for (const stop of this.stops.splice(0)) stop();
		if (reason === "quit") {
			this.removeLease();
			this.host.history.clear();
		}
		this.status(undefined);
	}

	activity(): void {
		this.lastActivityAt = this.host.now();
	}

	private status(text: string | undefined): void {
		if (text === this.lastStatus) return;
		this.lastStatus = text;
		this.host.setStatus(text);
	}

	private scheduleCycle(): void {
		const interval = this.config().intervalMinutes * 60_000;
		const delay = interval * (1 - JITTER + 2 * JITTER * this.host.random());
		this.stops.push(this.host.setTimer(() => {
			this.maybeSpawn();
		}, delay));
	}

	/** Starts a detached cycle when the last check is older than the interval and no cycle runs. */
	maybeSpawn(): void {
		const config = this.config();
		const state = safeState(this.host.paths);
		if (!config.enabled || config.paused || !state?.current) return;
		if (state.lastCheck !== undefined && this.host.now() - state.lastCheck < config.intervalMinutes * 60_000) return;
		if (isLockHeld(this.host.paths.lock, { staleMs: LOCK_STALE_MS })) return;
		this.host.spawnCycle(false);
	}

	/** Reloads or restarts this session made for `target`, counted back from the end of the branch. */
	private attempts(target: string): number {
		// A new session has no file and no entries yet; then only the launcher's count shows a loop.
		const launcher = this.host.restarted?.target === target ? this.host.restarted.count : 0;
		return Math.max(launcher, this.branchAttempts(target));
	}

	private branchAttempts(target: string): number {
		let count = 0;
		for (const entry of [...this.host.branch()].reverse()) {
			if (entry.type !== "custom" || entry.customType !== UPDATE_ENTRY) continue;
			const data = entry.data as UpdateEntryData | undefined;
			if (data?.phase !== "start" || data.target !== target) break;
			count++;
		}
		return count;
	}

	private ready(state: UpdateState): boolean {
		const set = state.current;
		if (!set) return false;
		try {
			return piCurrentMatches(this.host.paths, set) && settingsMatch(readSettingsPackages(settingsFile(this.host.agentDir)), set, this.host.paths.root);
		} catch {
			return false;
		}
	}

	/** The launcher started this process, and the request file can name the session and the options line by line. */
	private canRestart(): boolean {
		const file = this.host.sessionFile();
		return this.host.restartToken !== undefined && this.host.launchedByLauncher && file !== undefined && !/[\r\n]/.test(file) && replayArgs(this.host.argv).ok;
	}

	decision(state = safeState(this.host.paths)): Decision {
		if (!state?.current) return { kind: "none" };
		const target = fingerprint(state.current);
		return decide({
			own: this.own, state, storeRoot: this.host.paths.root, adopt: this.config().adopt, mode: this.host.mode,
			canRestart: this.canRestart(),
			ready: this.ready(state), attempts: this.attempts(target),
		});
	}

	private idle(kind: "reload" | "restart"): boolean {
		return idleFor(kind, { ...this.host.signals(), now: this.host.now(), lastActivityAt: this.lastActivityAt });
	}

	/** Every 15 s: the status line, and a move to the current set when the session is idle. */
	poll(): void {
		if (this.stopped) return;
		const state = safeState(this.host.paths);
		const decision = this.decision(state);
		const activity = state?.activity && this.host.now() - state.activity.since < ACTIVITY_MAX_AGE_MS ? `updating: ${state.activity.text}` : undefined;
		if (state?.launcherProblem && !this.launcherNoticeShown) {
			this.launcherNoticeShown = true;
			this.host.notify(state.launcherProblem.message, "warning");
		}
		const warning = state?.launcherProblem ? LAUNCHER_WARNING : undefined;
		const moves = decision.kind === "reload" || decision.kind === "restart";
		if (!moves) this.waiting = undefined;
		else if (this.waiting?.target !== decision.target) this.waiting = { target: decision.target, since: this.host.now() };
		const long = moves && this.host.now() - this.waiting!.since >= LONG_WAIT_MS ? LONG_WAIT_TEXT[decision.kind] : undefined;
		this.status(activity ?? warning ?? (decision.kind === "notice" ? decision.text : long));
		if (!moves) return;
		if (!this.idle(decision.kind)) return;
		this.host.dispatchApply();
	}

	/** The apply command: checks again, then reloads or restarts. Runs as a command, where `reload` is safe. */
	async apply(actions: { readonly reload: () => Promise<void>; readonly shutdown: () => void }): Promise<void> {
		const state = safeState(this.host.paths);
		const decision = this.decision(state);
		if ((decision.kind !== "reload" && decision.kind !== "restart") || !this.idle(decision.kind) || !state?.current) return;
		const after = `Updated ${decision.change}`;
		this.announce({ phase: "start", target: decision.target, text: decision.text, after, from: this.host.extrasVersion });
		if (decision.kind === "reload") return this.watchedReload(actions, decision.target, after);
		const request = this.requestRestart(decision.target, after);
		if (request === undefined) return;
		try {
			actions.shutdown();
		} catch (error) {
			undoRestart(request);
			throw error;
		}
	}

	/**
	 * Writes the launcher's restart request and the restart intent; returns the
	 * request file, or undefined when this session cannot restart.
	 */
	private requestRestart(target: string, after: string): string | undefined {
		const file = this.host.sessionFile();
		const replay = replayArgs(this.host.argv);
		if (!file || !this.host.restartToken || !replay.ok || !this.canRestart()) return undefined;
		mkdirSync(this.host.paths.restart, { recursive: true, mode: 0o700 });
		const request = join(this.host.paths.restart, this.host.restartToken);
		// Line 1: the session to resume. Line 2: what the restarted Pi says when the session has no file yet.
		// Line 3: the target, for the launcher's count. Then one launch option per line (none holds a line break).
		const lines = [file, after.replace(/[\r\n]+/g, " "), target.replace(/[\r\n]+/g, " ")];
		writeFileSync(request, [...lines, ...replay.args].map((line) => `${line}\n`).join(""), { mode: 0o600 });
		// Pi reports this shutdown as a plain quit; the intent tells shell-jobs to hand its jobs to the next Pi.
		markRestart(file);
		return request;
	}

	/**
	 * A reload with a watchdog. The timers belong to this call, not to `stops`:
	 * the old module's session_shutdown runs `stop` during the reload, and a
	 * stuck reload is exactly when the watchdog must still run.
	 */
	private async watchedReload(actions: { readonly reload: () => Promise<void>; readonly shutdown: () => void }, target: string, after: string): Promise<void> {
		let shutDown = false;
		let stopExit: (() => void) | undefined;
		const stopWatch = this.host.setOnce(() => {
			shutDown = this.reloadStuck(actions, target, after);
			if (shutDown) {
				stopExit = this.host.setOnce(() => {
					this.host.log(`Pi did not quit ${SHUTDOWN_STUCK_MS / 1000} s after the stuck reload to ${target}: exit for the launcher's restart`);
					this.host.exit(0);
				}, SHUTDOWN_STUCK_MS);
			}
		}, RELOAD_STUCK_MS);
		try {
			await actions.reload();
		} finally {
			stopWatch();
			// After a shutdown() that worked, Pi has stopped its TUI and quits whatever the reload does now.
			// The exit timer stays: if that quit hangs, the process would live on with no screen, and the
			// launcher, with the restart request on disk, waits for it to end.
			if (!shutDown) stopExit?.();
		}
	}

	/** The watchdog fired: restart through the launcher when possible, else tell the user. True when Pi was asked to quit. */
	private reloadStuck(actions: { readonly shutdown: () => void }, target: string, after: string): boolean {
		this.host.log(`reload to ${target} did not finish in ${RELOAD_STUCK_MS / 1000} s: an extension's session_shutdown handler does not end`);
		const request = this.host.mode === "tui" ? this.requestRestart(target, after) : undefined;
		if (request === undefined) {
			this.warn(STUCK_QUIT);
			return false;
		}
		this.warn(STUCK_RESTART);
		try {
			actions.shutdown();
			this.host.log("asked Pi to quit; the launcher restarts the session");
			return true;
		} catch (error) {
			// A stale context: the old extensions were already let go, so the hang is later in the reload.
			undoRestart(request);
			this.host.log(`could not ask Pi to quit: ${error instanceof Error ? error.message : String(error)}`);
			this.warn(STUCK_QUIT);
			return false;
		}
	}

	/** A notice from a timer: a context that went stale must not stop the steps after it. */
	private warn(text: string): void {
		try {
			this.host.notify(text, "warning");
		} catch {
			// The log has the line.
		}
	}

	private announce(data: UpdateEntryData): void {
		this.host.appendEntry(data);
		// The terminal draws the entry; an RPC client gets a notice.
		if (this.host.mode !== "tui") this.host.notify(data.text, "info");
	}

	/** After a reload or restart: say that the update happened, once. */
	private reportAdoption(): void {
		const state = safeState(this.host.paths);
		if (!state?.current || piDiffers(this.own, state.current) || packagesDiffer(this.own, state.current)) return;
		const target = fingerprint(state.current);
		const last = [...this.host.branch()].reverse().find((entry) => entry.type === "custom" && entry.customType === UPDATE_ENTRY);
		const data = last?.data as UpdateEntryData | undefined;
		if (data?.phase === "start" && data.target === target) {
			const from = data.from ?? OLD_FROM.exec(data.text)?.[1];
			const to = this.host.extrasVersion;
			this.announce({ phase: "done", target, text: data.after ?? "Updated.", ...(from && from !== to ? { extras: { from, to } } : {}) });
		}
		else if (data === undefined && this.host.updateNote) this.announce({ phase: "done", target, text: this.host.updateNote });
	}
}
