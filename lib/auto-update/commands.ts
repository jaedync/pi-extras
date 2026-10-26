/** `rollback` and `gc`: small commands that run under the updater lock. */
import { waitForLock, type FileLock } from "../file-lock.ts";
import { collect, changedKeys, LOCK_STALE_MS, switchTo } from "./cycle.ts";
import { CommandError } from "./enable.ts";
import type { Log } from "./log.ts";
import type { StorePaths } from "./paths.ts";
import { PI_KEY } from "./plan.ts";
import { readSettingsPackages, settingsFile } from "./settings.ts";
import { markBad, readState, updateState } from "./state.ts";
import { setLabel } from "./status.ts";

export interface CommandDeps {
	readonly paths: StorePaths;
	readonly agentDir: string;
	readonly now: () => number;
	readonly log: Log;
	readonly out: (line: string) => void;
}

const LOCK_WAIT_MS = 2_000;

function takeLock(paths: StorePaths): FileLock {
	try {
		return waitForLock(paths.lock, LOCK_WAIT_MS, { staleMs: LOCK_STALE_MS });
	} catch {
		throw new CommandError("An update cycle runs now. Try again in a few minutes.");
	}
}

/**
 * Switches back to the previous set. The versions left behind are marked
 * bad, so the next cycle does not install them again; a newer release of
 * the same source is taken as usual.
 */
export function rollback(deps: CommandDeps): void {
	const lock = takeLock(deps.paths);
	try {
		const state = readState(deps.paths.state);
		if (!state.current || !state.previous) throw new CommandError("There is no previous set to go back to.");
		const from = state.current;
		const to = state.previous;
		const packages = readSettingsPackages(settingsFile(deps.agentDir));
		switchTo(deps, to, packages);
		updateState(deps.paths.state, (now) =>
			changedKeys(to, from).reduce((next, key) => {
				const id = key === PI_KEY ? from.pi.version : from.packages[key]?.id;
				return id === undefined ? next : markBad(next, key, id, "rolled back by the user", deps.now());
			}, now),
		);
		deps.log(`rolled back from ${setLabel(from)} to ${setLabel(to)}`);
		deps.out(`Rolled back to: ${setLabel(to)}.`);
		deps.out("Running sessions move to it when they are idle. New sessions start with it.");
	} finally {
		lock.release();
	}
}

export function gc(deps: CommandDeps): void {
	const lock = takeLock(deps.paths);
	const removed: string[] = [];
	try {
		collect({ ...deps, log: (line) => {
			if (line.startsWith("removed ")) removed.push(line.slice("removed ".length));
			deps.log(line);
		} });
	} finally {
		lock.release();
	}
	deps.out(removed.length > 0 ? `Removed ${removed.length} ${removed.length === 1 ? "folder" : "folders"}: ${removed.join(", ")}` : "Nothing to remove.");
}
