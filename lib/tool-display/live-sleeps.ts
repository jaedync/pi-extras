/**
 * Marks each bash call's shell so its sleeps can be watched (lib/sleep-watch.ts).
 *
 * The call's execute picks a run id and watches it; the shell operations,
 * reached from inside that execute, put the id in the shell's environment as
 * `PI_EXTRAS_RUN`. The command and its output stay exactly as they were.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { ShellOperations } from "../chain/exec.ts";
import type { LiveSleeps } from "../sleep-progress.ts";
import { RUN_VARIABLE, type SleepWatch } from "../sleep-watch.ts";

/** The run of the bash call whose execute this code runs inside. */
const current = new AsyncLocalStorage<string>();

/** Shell operations that give the shell the run of the call it serves. */
export function runOperations(base: ShellOperations): ShellOperations {
	return {
		exec(command, cwd, options) {
			const run = current.getStore();
			// Pi always passes the environment; without one the shell gets Pi's own, unmarked.
			if (run === undefined || options.env === undefined) return base.exec(command, cwd, options);
			return base.exec(command, cwd, { ...options, env: { ...options.env, [RUN_VARIABLE]: run } });
		},
	};
}

// Pi's own execute has typed callbacks; the wrapper only passes them through.
type Execute = (toolCallId: string, params: any, signal: any, onUpdate: any, ctx: any) => Promise<unknown>;

export interface LiveSleepRuns {
	/** The bash definition with an execute that watches its call's sleeps while it runs. */
	wrap<T extends { execute: (...args: any[]) => Promise<unknown> }>(definition: T): Omit<T, "execute"> & { execute: Execute };
	/** A running call's sleeps so far. */
	sleeps(toolCallId: string): LiveSleeps | undefined;
}

export function liveSleepRuns(watch: SleepWatch, newRun: () => string): LiveSleepRuns {
	const runs = new Map<string, string>();
	return {
		wrap(definition) {
			const execute: Execute = async (toolCallId, params, signal, onUpdate, ctx) => {
				const run = newRun();
				runs.set(toolCallId, run);
				const stop = watch.watch({ run });
				try {
					return await current.run(run, () => definition.execute(toolCallId, params, signal, onUpdate, ctx));
				} finally {
					stop();
					runs.delete(toolCallId);
				}
			};
			return { ...definition, execute };
		},
		sleeps(toolCallId) {
			const run = runs.get(toolCallId);
			return run === undefined ? undefined : watch.sleeps({ run });
		},
	};
}
