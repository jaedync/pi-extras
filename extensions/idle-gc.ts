/**
 * Idle GC. Once the agent has been idle for 30 seconds, one full garbage
 * collection frees what the last run left and gives the memory back to the
 * system (lib/idle-gc.ts). Features are unchanged; the pause (tens to a few
 * hundred milliseconds) falls while nothing waits on it.
 *
 * PI_IDLE_GC=off (or `0`, `false`) disables it for that session.
 */
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { idleGc, lastResortCollector, type IdleGc } from "../lib/idle-gc.ts";
import { errorText, operationalError } from "../lib/operational-log.ts";

const LOG_FILE = join(getAgentDir(), "idle-gc.log");

const DISABLED = new Set(["0", "off", "false", "none"]);

export default function idleGcExtension(pi: ExtensionAPI): void {
	if (DISABLED.has(process.env.PI_IDLE_GC?.trim().toLowerCase() ?? "")) return;
	let gc: IdleGc | undefined;
	pi.on("session_start", () => {
		gc?.stop();
		const collect = lastResortCollector();
		if (!collect) return;
		gc = idleGc({
			collect,
			rss: () => process.memoryUsage.rss(),
			now: () => Date.now(),
			timers: {
				// Unref'd: a wait in progress never keeps a finished Pi from exiting.
				setTimeout: (fn, ms) => setTimeout(fn, ms).unref(),
				clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
			},
			// Fail-open: the session runs on as it did before, and the log says why.
			onError: (error) => operationalError(LOG_FILE, "idle-gc", `collect failed: ${errorText(error)}`),
		});
		// Startup leaves garbage too.
		gc.idle();
	});
	pi.on("agent_start", () => gc?.busy());
	pi.on("agent_end", () => gc?.idle());
	pi.on("session_shutdown", () => {
		gc?.stop();
		gc = undefined;
	});
}
