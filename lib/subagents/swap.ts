/**
 * A swap: a running child whose session a launch now would not make (new code
 * after a /reload, or an edited file the launch read, stamp.ts) moves to a new
 * session at its next safe turn boundary, as the same run. The team asks at
 * each boundary (team.ts `turnEnded`); the session ends its loop there
 * (child.ts), and the run goes on from its session file through the same
 * relaunch a fallback model uses.
 *
 * Safe means: the turn's tool results are recorded and no tool runs, which is
 * where Pi asks; the run is not stopping; and the child waits on no one in a
 * tool, as a question with expectReply or a subagent with wait: true does
 * until its answer or report comes. Each cause swaps at most once per run, so
 * a file that changed during the new launch, which leaves that session stale
 * too, does not swap again and again.
 */
import { changedFiles, type LaunchStamp } from "./stamp.ts";
import type { AgentState } from "./types.ts";

/** What the new session is prompted with when the swap came at a turn boundary: it continues from its last tool result. */
export const SWAP_NOTE = "[Your session moved to current code and settings. Your work so far is above. Continue where you stopped.]";

/** What the widget shows while the run moves. */
export const swapActivity = (causes: readonly string[]): string => `moving to a new session: ${causeWords(causes)}`;

/**
 * Why a session with `stamp` is stale, one cause per changed file
 * (`path@identity`), or its code (`code@generation`) when no file changed.
 * None for a session that is current.
 */
export function staleCauses(stamp: LaunchStamp | undefined, current: boolean): string[] {
	if (current) return [];
	const files = stamp ? changedFiles(stamp) : [];
	return files.length > 0 ? files : [`code@${stamp?.generation ?? "unknown"}`];
}

/** The causes in a few words: `settings.json changed`, `new code`. */
export function causeWords(causes: readonly string[]): string {
	const files = causes.filter((cause) => !cause.startsWith("code@")).map((cause) => cause.slice(0, cause.lastIndexOf("@")).split(/[\\/]/).at(-1));
	const code = files.length < causes.length ? ["new code"] : [];
	return [...code, ...(files.length > 0 ? [`${[...new Set(files)].join(", ")} changed`] : [])].join(", ");
}

/** What the team knows about a child at a turn boundary. */
export interface SwapFacts {
	/** `subagents.swapAtTurn`. */
	readonly enabled: boolean;
	readonly state: AgentState | undefined;
	/** It waits on an answer to a question it asked. */
	readonly asking: boolean;
	/** A subagent of its own blocks a call of it (wait: true). */
	readonly blocked: boolean;
	/** Its run is stopping, or the team is closing. */
	readonly ending: boolean;
	/** Its model is in scope, so a launch now would take it. */
	readonly launchable: boolean;
	/** Why its session is stale (`staleCauses`); none when it is current. */
	readonly causes: readonly string[];
	/** The causes this run already swapped for. */
	readonly handled: ReadonlySet<string>;
}

/** Whether the child moves to a new session now. */
export function swapDue(facts: SwapFacts): boolean {
	if (!facts.enabled || facts.state !== "running" || facts.asking || facts.blocked || facts.ending || !facts.launchable) return false;
	return facts.causes.some((cause) => !facts.handled.has(cause));
}

/** The swaps of the team's runs: the one each run ends its prompt for, and the causes each run already swapped for. */
export class TurnSwaps {
	private readonly pending = new Map<string, readonly string[]>();
	private readonly handled = new Map<string, ReadonlySet<string>>();

	/** The causes `name`'s run already swapped for. */
	done(name: string): ReadonlySet<string> {
		return this.handled.get(name) ?? new Set();
	}

	/** Whether `name`'s run ends its prompt for a swap. */
	ending(name: string): boolean {
		return this.pending.has(name);
	}

	/** `name`'s run ends its prompt to swap for `causes`. */
	request(name: string, causes: readonly string[]): void {
		this.pending.set(name, [...causes]);
	}

	/** The causes of the swap `name`'s run asked for, now under way; undefined when none was asked. */
	take(name: string): readonly string[] | undefined {
		const causes = this.pending.get(name);
		this.pending.delete(name);
		return causes;
	}

	/** The run swaps for `causes` now: it never swaps for them again. */
	swapped(name: string, causes: readonly string[]): void {
		this.handled.set(name, new Set([...this.done(name), ...causes]));
	}

	/** The run ended: its next run starts with nothing handled. */
	end(name: string): void {
		this.pending.delete(name);
		this.handled.delete(name);
	}
}
