/**
 * The prompts of one child session, with the stop that Pi's AgentSession does
 * not give on its own (formal/subagents-lifecycle/README.md, F1, F2 and F5):
 *
 * - `abort()` finds no run while `prompt()` still awaits before the run starts
 *   (an `input` handler, an extension command, a login check), and Pi then
 *   runs that prompt in full. The gate keeps the abort and aborts again when
 *   Pi says the run started, before its first request, where Pi's own
 *   agent_start check stops it.
 * - The gate's abort resolves once the prompt in flight ended, in every phase,
 *   so a dispose after it can't leave a run going with no listener.
 * - `steer()` awaits the input handlers before the message reaches Pi's queue.
 *   The gate's prompt returns only once every steer sent meanwhile is queued,
 *   so the team takes it as the run's next prompt instead of losing it.
 */

/** The parts of Pi's AgentSession the gate uses. */
export interface PromptSession {
	prompt(text: string, options?: { preflightResult?: (disposition: string) => void }): Promise<void>;
	abort(): Promise<void>;
	steer(text: string): Promise<unknown>;
}

export interface PromptGate {
	/** Pi's prompt; resolves or throws once it ended and each steer sent meanwhile is in Pi's queue. */
	prompt(text: string): Promise<void>;
	/** Aborts the prompt in flight, also one whose run has not started, and resolves once it ended. */
	abort(): Promise<void>;
	/** Steers through Pi's input handlers; the prompt in flight waits until it is queued. */
	steer(text: string): void;
	/** Whether a prompt is in flight. */
	busy(): boolean;
}

interface Run { aborted: boolean; ended?: Promise<void> }

const ignore = (): void => undefined;

export function promptGate(session: PromptSession): PromptGate {
	let current: Run | undefined;
	const steers = new Set<Promise<void>>();
	return {
		async prompt(text) {
			const run: Run = { aborted: false };
			current = run;
			const prompted = session.prompt(text, {
				// Pi calls this after its run exists and before the first request (agent-session.js _startRun).
				preflightResult: (disposition) => { if (disposition === "started" && run.aborted) session.abort().catch(ignore); },
			});
			run.ended = prompted.then(ignore, ignore);
			try {
				await prompted;
			} finally {
				if (current === run) current = undefined;
			}
			// No await when nothing is in flight: the team's continuation keeps its place in the event loop.
			while (steers.size > 0) await Promise.allSettled([...steers]);
		},
		async abort() {
			const run = current;
			if (run) run.aborted = true;
			await session.abort();
			await run?.ended;
		},
		steer(text) {
			const queued: Promise<void> = session.steer(text).then(ignore, ignore).finally(() => steers.delete(queued));
			steers.add(queued);
		},
		busy: () => current !== undefined,
	};
}
