/**
 * The prompts of one child session, with the stop that Pi's AgentSession does
 * not give on its own (formal/subagents-lifecycle/README.md, F1, F2 and F5):
 *
 * - `abort()` finds no run while `prompt()` still awaits before the run starts
 *   (an `input` handler, an extension command, a login check), and Pi then
 *   runs that prompt in full. The gate keeps the abort. It aborts again when
 *   Pi starts a compaction before the run or says the run started, before its
 *   first request, where Pi's own agent_start check stops it.
 * - The gate's abort resolves once the prompt in flight ended, in every phase.
 *   Before the run starts, it waits for at most GATE_WAIT_MS: a stop or a
 *   dispose can't hang on a slow handler.
 *   After `shut()`, the gate's own agent_start listener stops an aborted run,
 *   because Pi's dispose takes away Pi's listener: a session whose dispose
 *   did not wait to the end never sends its first request.
 * - `steer()` awaits the input handlers before the message reaches Pi's queue.
 *   The gate's prompt returns only once every steer sent meanwhile is queued,
 *   so the team takes it as the run's next prompt instead of losing it.
 */

/** The parts of Pi's AgentSession the gate uses. */
export interface PromptSession {
	prompt(text: string, options?: { preflightResult?: (disposition: string) => void }): Promise<void>;
	abort(): Promise<void>;
	steer(text: string): Promise<unknown>;
	subscribe?(listener: (event: { type: string }) => void): () => void;
	/** Pi's agent: its listeners stay after AgentSession.dispose, which removes only the session's own. */
	agent?: { subscribe(listener: (event: { type: string }) => void): () => void; abort(): void };
}

export interface PromptGate {
	/** Pi's prompt; resolves or throws once it ended and each steer sent meanwhile is in Pi's queue. */
	prompt(text: string): Promise<void>;
	/** Aborts the prompt in flight, also one whose run has not started, and resolves once it ended (before its start, at most after GATE_WAIT_MS). */
	abort(): Promise<void>;
	/** Aborts as `abort` does, for a session about to be disposed: an aborted run that starts after this stops at agent_start. */
	shut(): Promise<void>;
	/** Steers through Pi's input handlers; the prompt in flight waits until it is queued. */
	steer(text: string): void;
	/** Resolves once no steer is in flight; undefined when none is, so a caller need not await. */
	steering(): Promise<void> | undefined;
	/** Whether a prompt is in flight. */
	busy(): boolean;
}

/**
 * How long an abort waits for a prompt whose run has not started. Pi's own
 * abort waits for idle, and a `before_agent_start` handler or a compaction in
 * _prepareRun keeps the session busy for as long as it takes. A prompt that
 * waits in an `input` handler or an extension command is not busy, so Pi's
 * abort returns, but the gate still waits for the prompt. The gate stops the
 * run when it starts. Once the run started, the abort waits as long as Pi's
 * abort of the loop takes, as without the gate.
 */
export const GATE_WAIT_MS = 10_000;

interface Run { aborted: boolean; started: boolean; ended?: Promise<unknown> }

const ignore = (): void => undefined;

/** Where the gate reports a failure that no caller awaits: an abort it sent on its own, or a steer. */
export type GateError = (what: string, error: unknown) => void;

/** `done`, or GATE_WAIT_MS, whichever comes first. */
function bounded(done: Promise<void>): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const limit = new Promise<void>((resolve) => { timer = setTimeout(resolve, GATE_WAIT_MS); timer.unref?.(); });
	return Promise.race([done, limit]).finally(() => clearTimeout(timer));
}

export function promptGate(session: PromptSession, onError: GateError): PromptGate {
	let current: Run | undefined;
	let shut = false;
	const steers = new Set<Promise<void>>();
	// A compaction in Pi's _prepareRun runs before "started"; Pi's abort cancels it, as the run exists by then.
	const abortAgain = (what: string): void => { session.abort().catch((error: unknown) => onError(what, error)); };
	session.subscribe?.((event) => { if (event.type === "compaction_start" && current?.aborted) abortAgain("the abort at compaction_start"); });
	// Pi's agent_start check (agent-session.js _handleAgentEvent) does this until Pi's dispose disconnects it.
	const agent = session.agent;
	agent?.subscribe((event) => { if (event.type === "agent_start" && shut && current?.aborted) agent.abort(); });
	const steering = (): Promise<void> | undefined => (steers.size === 0 ? undefined : (async () => {
		while (steers.size > 0) await Promise.allSettled([...steers]);
	})());
	const abort = async (): Promise<void> => {
		const run = current;
		if (run) run.aborted = true;
		const done = Promise.all([session.abort(), run?.ended]).then(ignore);
		await (run && !run.started ? bounded(done) : done);
	};
	return {
		async prompt(text) {
			const run: Run = { aborted: false, started: false };
			current = run;
			const prompted = session.prompt(text, {
				// Pi calls this after its run exists and before the first request (agent-session.js _startRun).
				preflightResult: (disposition) => {
					if (disposition === "started") run.started = true;
					// A throw here would leave Pi's run active and its idle wait open: a stop then never returns.
					if (disposition === "started" && run.aborted) abortAgain("the abort at the run's start");
				},
			});
			// Only when it ended; its error goes to this prompt's caller below.
			run.ended = Promise.allSettled([prompted]);
			try {
				await prompted;
			} finally {
				if (current === run) current = undefined;
			}
			// No await when nothing is in flight: the team's continuation keeps its place in the event loop.
			const landing = steering();
			if (landing) await landing;
		},
		abort,
		shut() {
			shut = true;
			return abort();
		},
		steer(text) {
			const queued: Promise<void> = session.steer(text).then(ignore, (error: unknown) => onError("a steer", error)).finally(() => steers.delete(queued));
			steers.add(queued);
		},
		steering,
		busy: () => current !== undefined,
	};
}
