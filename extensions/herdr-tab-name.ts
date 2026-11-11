/**
 * Herdr Tab Name. In a Herdr tab, the Pi session's name and the tab's label
 * stay the same (lib/herdr-tab-name.ts has the rules): `/name` renames the
 * tab, a session with no name takes the tab's label, and a tab renamed in
 * Herdr renames the session after the next run. Tools that address sessions
 * by name then use the name the tab bar shows.
 *
 * It runs only in the TUI, inside Herdr, in a tab with one pane.
 * `PI_HERDR_TAB_NAME=off`, or `herdrTabName.enabled: false` in
 * pi-extras.json, turns it off.
 */
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { readSection } from "../lib/extras-config.ts";
import { applies, tabNameSync, type TabNameSync } from "../lib/herdr-tab-name.ts";
import { errorText, operationalError } from "../lib/operational-log.ts";

const LOG_FILE = join(getAgentDir(), "herdr-tab-name.log");
const HERDR_TIMEOUT_MS = 3_000;
const HERDR_OUTPUT_MAX = 16 * 1024 * 1024;
/**
 * The second look after a session start. On `/new` and `/resume` the pane
 * still reports the old session until Herdr's own extension has sent the new
 * one, and the first look then finds no tab.
 */
const SECOND_LOOK_MS = 2_000;

export interface HerdrTabNameOptions {
	readonly env?: NodeJS.ProcessEnv;
	readonly settings?: Record<string, unknown>;
	/** Runs `herdr` with these arguments and gives its output. */
	readonly run?: (args: readonly string[]) => Promise<string>;
	/** Calls `fn` once after `ms`; the result cancels it. */
	readonly later?: (fn: () => void, ms: number) => () => void;
	/** Gets each failure; the default writes it to the log file. */
	readonly onError?: (error: unknown) => void;
}

/** Runs the `herdr` program of this environment, with no shell. */
export function herdrCli(env: NodeJS.ProcessEnv): (args: readonly string[]) => Promise<string> {
	const bin = env.HERDR_BIN_PATH?.trim() || "herdr";
	return (args) => new Promise((resolve, reject) => {
		execFile(bin, [...args], { timeout: HERDR_TIMEOUT_MS, maxBuffer: HERDR_OUTPUT_MAX, windowsHide: true, env }, (error, stdout) => {
			// Node's message holds the whole command line, and with it the session name: the log gets only the subcommand.
			if (error) reject(new Error(`herdr ${args.slice(0, 2).join(" ")} failed: ${String(error.code ?? error.signal ?? "no exit code")}`));
			else resolve(stdout);
		});
	});
}

/** The CLI's JSON answer; an `error` member is a refusal (a tab that is gone, for example). */
function answer(output: string): unknown {
	const parsed: unknown = JSON.parse(output);
	const refusal = (parsed as { error?: { code?: unknown; message?: unknown } } | null)?.error;
	if (refusal) throw new Error(`herdr refused: ${String(refusal.code ?? "")} ${String(refusal.message ?? "")}`.trim());
	return parsed;
}

export default function herdrTabNameExtension(pi: ExtensionAPI, options: HerdrTabNameOptions = {}): Pick<TabNameSync, "idle"> | undefined {
	const env = options.env ?? process.env;
	if (!applies(env, options.settings ?? readSection("herdrTabName"))) return undefined;
	const run = options.run ?? herdrCli(env);
	// Unref'd: a wait in progress never keeps a finished Pi from exiting.
	const later = options.later ?? ((fn, ms) => { const timer = setTimeout(fn, ms).unref(); return () => clearTimeout(timer); });
	const onError = options.onError ?? ((error) => operationalError(LOG_FILE, "herdr-tab-name", errorText(error)));
	let sync: TabNameSync | undefined;
	let cancelSecondLook: (() => void) | undefined;
	const stop = () => {
		cancelSecondLook?.();
		cancelSecondLook = undefined;
		sync?.stop();
		sync = undefined;
	};

	pi.on("session_start", (_event, ctx) => {
		stop();
		// Print, JSON and RPC runs are not the program the tab shows.
		if (ctx.mode !== "tui") return;
		const self = { sessionFile: ctx.sessionManager.getSessionFile(), sessionId: ctx.sessionManager.getSessionId(), paneId: env.HERDR_PANE_ID };
		sync = tabNameSync({
			self: () => self,
			name: () => pi.getSessionName(),
			setName: (name) => pi.setSessionName(name),
			snapshot: async () => answer(await run(["api", "snapshot"])),
			// The label is one argument, and Herdr takes it as written, a leading dash too.
			renameTab: async (tabId, label) => { answer(await run(["tab", "rename", tabId, label])); },
			onError,
		});
		sync.request();
		cancelSecondLook = later(() => sync?.request(), SECOND_LOOK_MS);
	});
	pi.on("session_info_changed", () => sync?.request());
	// A tab renamed in Herdr sends Pi no event: look after each run.
	pi.on("agent_end", () => sync?.request());
	pi.on("session_shutdown", stop);
	return { idle: async () => { await sync?.idle(); } };
}
