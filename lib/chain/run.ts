/**
 * The record of one chained bash call as it runs: which step is running, when
 * each step started and ended, its exit status and its share of the output.
 * Built from the marks the rewritten command prints, and saved to the session
 * when the call ends so a resumed session can show the same steps.
 */
import type { Outcome } from "../band/band.ts";
import type { Mark } from "./instrument.ts";
import type { Chain } from "./split.ts";

export type StepState = "waiting" | "running" | "ok" | "fail" | "handled" | "skipped" | "timeout" | "aborted";

export interface StepRecord {
	startedAt?: number;
	endedAt?: number;
	code?: number;
	output: string;
}

/** What a finished chain leaves in the session: times relative to its start, and each step's last output. */
export interface SavedChain {
	readonly v: 1;
	readonly toolCallId: string;
	readonly outcome?: Outcome;
	/** The first step is a leading cd. */
	readonly cd?: true;
	readonly steps: ReadonlyArray<{ readonly at?: number; readonly ms?: number; readonly code?: number; readonly tail?: string }>;
}

/** The session entry a finished chain is saved in. Custom entries never reach the model. */
export const CHAIN_ENTRY = "tool-display-chain";
/** Announced on Pi's event bus when a chain finishes, with `{ toolCallId, ran }`. */
export const CHAIN_EVENT = "pi-extras:chain-ran";

/** Steps a saved chain ran, not counting a leading cd; the chain's steps are needed to spot the cd. */
export function savedRan(saved: unknown): number | undefined {
	if (!isSaved(saved)) return undefined;
	return saved.steps.filter((step, index) => typeof step.at === "number" && !(index === 0 && saved.cd === true)).length;
}

/** Output kept per step while it runs; the tool result holds the rest. */
export const STEP_OUTPUT_CHARS = 64 * 1024;
/** Output saved per step for a resumed session. */
export const SAVED_TAIL_CHARS = 2 * 1024;

function tailOf(text: string, max: number): string {
	if (text.length <= max) return text;
	const cut = text.slice(text.length - max);
	const newline = cut.indexOf("\n");
	return newline >= 0 && newline < cut.length - 1 ? cut.slice(newline + 1) : cut;
}

export class ChainRun {
	readonly chain: Chain;
	readonly startedAt: number;
	readonly steps: StepRecord[];
	/** Whether this run happened in this process; restored runs never change. */
	readonly live: boolean;
	current = -1;
	endedAt?: number;
	outcome?: Outcome;

	constructor(chain: Chain, startedAt: number, live = true) {
		this.chain = chain;
		this.startedAt = startedAt;
		this.live = live;
		this.steps = chain.steps.map(() => ({ output: "" }));
	}

	mark(mark: Mark, now: number): void {
		const step = this.steps[mark.step];
		if (!step) return;
		if (mark.kind === "start") {
			step.startedAt = now;
			this.current = mark.step;
		} else {
			step.endedAt = now;
			step.code = mark.code;
		}
	}

	write(text: string): void {
		const step = this.steps[Math.max(0, this.current)]!;
		step.output = tailOf(step.output + text, STEP_OUTPUT_CHARS);
	}

	finish(outcome: Outcome, now: number): void {
		this.endedAt ??= now;
		this.outcome ??= outcome;
	}

	get done(): boolean {
		return this.endedAt !== undefined;
	}

	stateOf(index: number): StepState {
		const step = this.steps[index];
		if (!step) return "waiting";
		const laterStarted = this.steps.slice(index + 1).findIndex((other) => other.startedAt !== undefined);
		if (step.startedAt === undefined) return this.done || laterStarted >= 0 ? "skipped" : "waiting";
		if (step.endedAt === undefined) {
			if (!this.done) return "running";
			return this.outcome === "timeout" ? "timeout" : this.outcome === "aborted" ? "aborted" : "fail";
		}
		if (step.code === 0) return "ok";
		// A failure the next step that ran was there to catch (`a || b`) is expected, not an error.
		const next = laterStarted >= 0 ? this.chain.steps[index + 1 + laterStarted] : undefined;
		return next?.op === "||" ? "handled" : "fail";
	}

	/** Steps that ran, not counting a leading cd. */
	ran(): number {
		return this.steps.filter((step, index) => step.startedAt !== undefined && !this.chain.steps[index]?.cd).length;
	}

	/** The step whose output matters most: the running one, else the one that failed, else the last that ran. */
	focus(): number {
		const states = this.steps.map((_, index) => this.stateOf(index));
		const running = states.indexOf("running");
		if (running >= 0) return running;
		const failed = states.findIndex((state) => state === "fail" || state === "timeout" || state === "aborted");
		if (failed >= 0) return failed;
		for (let index = states.length - 1; index >= 0; index--) if (states[index] === "ok" || states[index] === "handled") return index;
		return 0;
	}

	/** How long a step took, or has taken so far. */
	stepMs(index: number, now: number): number | undefined {
		const step = this.steps[index];
		if (step?.startedAt === undefined) return undefined;
		return (step.endedAt ?? this.endedAt ?? now) - step.startedAt;
	}

	save(toolCallId: string): SavedChain {
		return {
			v: 1,
			toolCallId,
			...(this.outcome ? { outcome: this.outcome } : {}),
			...(this.chain.steps[0]?.cd ? { cd: true as const } : {}),
			steps: this.steps.map((step) => ({
				...(step.startedAt !== undefined ? { at: step.startedAt - this.startedAt } : {}),
				...(step.startedAt !== undefined && step.endedAt !== undefined ? { ms: step.endedAt - step.startedAt } : {}),
				...(step.code !== undefined ? { code: step.code } : {}),
				...(step.output ? { tail: tailOf(step.output, SAVED_TAIL_CHARS) } : {}),
			})),
		};
	}

	/** A finished run rebuilt from the session; undefined when the saved steps don't match the command. */
	static restore(chain: Chain, saved: unknown): ChainRun | undefined {
		if (!isSaved(saved) || saved.steps.length !== chain.steps.length) return undefined;
		const run = new ChainRun(chain, 0, false);
		saved.steps.forEach((step, index) => {
			const record = run.steps[index]!;
			if (typeof step.at === "number") record.startedAt = step.at;
			if (typeof step.at === "number" && typeof step.ms === "number") record.endedAt = step.at + step.ms;
			if (typeof step.code === "number") record.code = step.code;
			if (typeof step.tail === "string") record.output = step.tail;
		});
		const ends = run.steps.map((step) => step.endedAt ?? step.startedAt ?? 0);
		run.finish(saved.outcome ?? "ok", Math.max(0, ...ends));
		return run;
	}
}

function isSaved(value: unknown): value is SavedChain {
	if (!value || typeof value !== "object") return false;
	const saved = value as Partial<SavedChain>;
	return saved.v === 1 && typeof saved.toolCallId === "string" && Array.isArray(saved.steps)
		&& saved.steps.every((step) => !!step && typeof step === "object");
}
