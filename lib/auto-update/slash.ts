/**
 * `/pi-extras update [now | rollback | pause | resume]`, without Pi: the
 * extension passes in the session's own parts and shows the lines this
 * returns. `enable` and `disable` change files outside the agent dir, so
 * they stay in the CLI; the command only prints the line to run.
 */
import { join } from "node:path";
import { rollback } from "./commands.ts";
import { readConfig, writeConfig } from "./config.ts";
import { CommandError } from "./enable.ts";
import type { Log } from "./log.ts";
import type { StorePaths } from "./paths.ts";
import { readState, StateError, type UpdateState } from "./state.ts";
import { statusLines } from "./status.ts";

export const UPDATE_SUBCOMMANDS = ["now", "rollback", "pause", "resume"] as const;

export interface SlashDeps {
	readonly paths: StorePaths;
	readonly agentDir: string;
	readonly extrasDir: string;
	readonly now: () => number;
	readonly log: Log;
	/** What this session waits for, if anything: the adoption decision as a line. */
	readonly pending: () => string | undefined;
	readonly spawnCycle: () => void;
}

export interface SlashResult {
	readonly lines: readonly string[];
	readonly level: "info" | "warning";
}

const cliLine = (extrasDir: string, command: string) => `node ${join(extrasDir, "lib", "auto-update", "cli.ts")} ${command}`;

function stateOrEmpty(paths: StorePaths): UpdateState {
	try {
		return readState(paths.state);
	} catch (error) {
		// The message names the file and what to do; the command shows it as a warning.
		if (error instanceof StateError) throw new CommandError(error.message);
		throw error;
	}
}

function status(deps: SlashDeps): SlashResult {
	const lines = statusLines(stateOrEmpty(deps.paths), readConfig(deps.agentDir), deps.now()).map((line) => line.replace("node <pi-extras>/lib/auto-update/cli.ts enable", cliLine(deps.extrasDir, "enable")));
	const pending = deps.pending();
	return { lines: pending ? [...lines, `This session: ${pending}`] : lines, level: "info" };
}

function requireOn(deps: SlashDeps): void {
	const state = stateOrEmpty(deps.paths);
	if (!readConfig(deps.agentDir).enabled || !state.current) throw new CommandError(`Auto-update is off. To turn it on, run: ${cliLine(deps.extrasDir, "enable")}`);
}

export function updateCommand(args: string, deps: SlashDeps): SlashResult {
	const word = args.trim().toLowerCase();
	try {
		switch (word) {
			case "":
			case "status":
				return status(deps);
			case "now":
				requireOn(deps);
				deps.spawnCycle();
				return { lines: ["Started an update check. Use /pi-extras update to see its progress."], level: "info" };
			case "rollback": {
				requireOn(deps);
				const lines: string[] = [];
				rollback({ ...deps, out: (line) => lines.push(line) });
				return { lines, level: "info" };
			}
			case "pause":
			case "resume":
				writeConfig(deps.agentDir, { paused: word === "pause" });
				return { lines: [word === "pause" ? "Auto-update is paused. Use /pi-extras update resume to start it again." : "Auto-update runs again."], level: "info" };
			case "enable":
			case "disable":
				return { lines: [`Run this command in a shell: ${cliLine(deps.extrasDir, word)}`], level: "info" };
			default:
				return { lines: [`Use /pi-extras update, or /pi-extras update ${UPDATE_SUBCOMMANDS.join(" | ")}.`], level: "warning" };
		}
	} catch (error) {
		if (error instanceof CommandError) return { lines: [error.message], level: "warning" };
		throw error;
	}
}

