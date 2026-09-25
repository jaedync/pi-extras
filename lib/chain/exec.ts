/**
 * Wires chain steps into Pi's bash tool without changing what the model sees.
 *
 * `execute` splits the command; when it splits into two or more steps it runs
 * the rewritten command instead, under a fresh nonce. The shell operations,
 * which see every output chunk, look the nonce up, take the step marks out of
 * the stream and pass everything else on to Pi exactly as the shell wrote it.
 * The model's copy of the call (its arguments) is never touched, and the
 * output it reads is the original command's.
 */
import { StringDecoder } from "node:string_decoder";
import type { Outcome } from "../band/band.ts";
import { instrument, MarkStripper, supportedShell } from "./instrument.ts";
import { ChainRun } from "./run.ts";
import { splitChain } from "./split.ts";

export interface ShellOperations {
	exec(command: string, cwd: string, options: {
		onData: (data: Buffer) => void;
		signal?: AbortSignal;
		timeout?: number;
		env?: NodeJS.ProcessEnv;
	}): Promise<{ exitCode: number | null }>;
}

export interface ChainHooks {
	enabled(): boolean;
	now(): number;
	nonce(): string;
	started(toolCallId: string, run: ChainRun): void;
	ended(toolCallId: string, run: ChainRun): void;
}

/** Runs being executed right now, by nonce. */
export type ActiveRuns = Map<string, ChainRun>;

const NONCE = /\\036PI:([0-9a-f]{8,32}):/;

export function chainOperations(base: ShellOperations, active: ActiveRuns, now: () => number): ShellOperations {
	return {
		async exec(command, cwd, options) {
			const nonce = NONCE.exec(command)?.[1];
			const run = nonce ? active.get(nonce) : undefined;
			if (!nonce || !run) return base.exec(command, cwd, options);
			const stripper = new MarkStripper(nonce);
			const decoder = new StringDecoder("utf8");
			const deliver = (pieces: ReturnType<MarkStripper["push"]>) => {
				for (const piece of pieces) {
					if (Buffer.isBuffer(piece)) {
						run.write(decoder.write(piece));
						options.onData(piece);
					} else run.mark(piece, now());
				}
			};
			try {
				return await base.exec(command, cwd, { ...options, onData: (data) => deliver(stripper.push(data)) });
			} finally {
				deliver(stripper.flush());
				const rest = decoder.end();
				if (rest) run.write(rest);
			}
		},
	};
}

/** How a failed call ended, from the status line Pi's bash tool puts at the end of its error. */
export function outcomeOfError(error: unknown): Outcome {
	const message = error instanceof Error ? error.message : String(error);
	if (/Command timed out after \d+ seconds$/.test(message)) return "timeout";
	if (/Command aborted$/.test(message)) return "aborted";
	return "fail";
}

// Pi's own execute has typed callbacks; the wrapper only passes them through.
type Execute = (toolCallId: string, params: any, signal: any, onUpdate: any, ctx: any) => Promise<unknown>;

/** The bash definition with an execute that runs splittable commands step by step. */
export function withChains<T extends { execute: (...args: any[]) => Promise<unknown> }>(definition: T, shellPath: string | undefined, active: ActiveRuns, hooks: ChainHooks): Omit<T, "execute"> & { execute: Execute } {
	// Pi picks bash, or sh where bash is missing, when no shell is set; both understand the rewrite.
	const shellOk = shellPath === undefined || shellPath === "" || supportedShell(shellPath);
	const execute: Execute = async (toolCallId, params, signal, onUpdate, ctx) => {
		const command = params && typeof params === "object" ? (params as { command?: unknown }).command : undefined;
		const chain = shellOk && typeof command === "string" && hooks.enabled() ? splitChain(command) : undefined;
		if (!chain || chain.steps.filter((step) => !step.cd).length < 2) return definition.execute(toolCallId, params, signal, onUpdate, ctx);
		const nonce = hooks.nonce();
		const run = new ChainRun(chain, hooks.now());
		active.set(nonce, run);
		hooks.started(toolCallId, run);
		try {
			const result = await definition.execute(toolCallId, { ...(params as object), command: instrument(chain, nonce) }, signal, onUpdate, ctx);
			run.finish("ok", hooks.now());
			return result;
		} catch (error) {
			run.finish(outcomeOfError(error), hooks.now());
			throw error;
		} finally {
			active.delete(nonce);
			hooks.ended(toolCallId, run);
		}
	};
	return { ...definition, execute };
}
