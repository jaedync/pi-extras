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

export interface HerdrTabNameOptions {
	readonly env?: NodeJS.ProcessEnv;
	readonly settings?: Record<string, unknown>;
	/** Runs `herdr` with these arguments and gives its output. */
	readonly run?: (args: readonly string[]) => Promise<string>;
}

function herdrCli(env: NodeJS.ProcessEnv): (args: readonly string[]) => Promise<string> {
	const bin = env.HERDR_BIN_PATH?.trim() || "herdr";
	return (args) => new Promise((resolve, reject) => {
		execFile(bin, [...args], { timeout: HERDR_TIMEOUT_MS, maxBuffer: HERDR_OUTPUT_MAX, windowsHide: true, env }, (error, stdout) => {
			if (error) reject(error);
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
	let sync: TabNameSync | undefined;

	pi.on("session_start", (_event, ctx) => {
		sync?.stop();
		sync = undefined;
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
			onError: (error) => operationalError(LOG_FILE, "herdr-tab-name", errorText(error)),
		});
		sync.request();
	});
	pi.on("session_info_changed", () => sync?.request());
	// A tab renamed in Herdr sends Pi no event: look after each run.
	pi.on("agent_end", () => sync?.request());
	pi.on("session_shutdown", () => {
		sync?.stop();
		sync = undefined;
	});
	return { idle: async () => { await sync?.idle(); } };
}
