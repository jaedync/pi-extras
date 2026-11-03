/**
 * The restart intent: auto-update sets it just before it ends the session to
 * restart Pi through the launcher. Pi reports that shutdown as a plain "quit"
 * (`ctx.shutdown()` ends in `AgentSessionRuntime.dispose`, reason "quit"), so
 * this is how shell-jobs tells a restart from a user quit and hands its jobs
 * over to the next Pi instead of stopping them.
 *
 * One value per process, on globalThis: each /reload loads the modules again.
 */

/** An intent this old is stale: the shutdown it announced did not come. */
export const RESTART_INTENT_MS = 60_000;

/** Versioned: a later pi-extras that keeps other data here picks a new symbol. */
const SLOT = Symbol.for("pi-extras.restart-intent.v1");

interface Intent {
	readonly sessionFile: string;
	readonly at: number;
}

const holder = () => globalThis as { [SLOT]?: Intent };

/** Say that the session in `sessionFile` ends for a restart, and the same session starts again. */
export function markRestart(sessionFile: string, now = Date.now()): void {
	holder()[SLOT] = { sessionFile, at: now };
}

export function clearRestart(): void {
	delete holder()[SLOT];
}

/** True while a restart of this session is under way. */
export function restartPending(sessionFile: string | undefined, now = Date.now()): boolean {
	const intent = holder()[SLOT];
	if (intent === undefined || sessionFile === undefined) return false;
	return intent.sessionFile === sessionFile && now - intent.at >= 0 && now - intent.at <= RESTART_INTENT_MS;
}
