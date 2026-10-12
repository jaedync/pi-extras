/**
 * The questions agents wait on. A child's question to main or its parent
 * blocks its `message` call until the answer comes, the reply timeout passes
 * or the call is aborted. Kept by asker, since a child may wait on several
 * agents at once; the team's record of the asker follows them (`changed`).
 */
import type { SendResult } from "./team.ts";

export interface Pending {
	readonly to: string;
	resolve(reply: string): void;
	reject(error: Error): void;
}

export interface QuestionOptions {
	readonly replyTimeoutMs: number;
	/** The asker's open questions changed: it now waits on these agents, or on none. */
	changed(asker: string, waitingOn: readonly string[]): void;
}

export class OpenQuestions {
	private readonly byAsker = new Map<string, Pending[]>();
	private readonly options: QuestionOptions;

	constructor(options: QuestionOptions) {
		this.options = options;
	}

	/** How many agents wait on an answer. */
	get size(): number {
		return this.byAsker.size;
	}

	/** What `asker` waits on now. */
	of(asker: string): readonly Pending[] {
		return this.byAsker.get(asker) ?? [];
	}

	/** Every asker with what it waits on. */
	entries(): Array<[string, readonly Pending[]]> {
		return [...this.byAsker];
	}

	/** Ends every open question with `error`, as a shutdown does. */
	rejectAll(error: Error): void {
		for (const questions of this.entries().map(([, open]) => open)) for (const question of questions) question.reject(error);
	}

	/** `from` waits for `to` to answer; resolves with the answer, or an error when none can come. */
	ask(from: string, to: string, signal?: AbortSignal): Promise<SendResult> {
		const { replyTimeoutMs } = this.options;
		return new Promise<SendResult>((resolve) => {
			const done = (result: SendResult) => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				const rest = this.of(from).filter((question) => question !== pending);
				if (rest.length > 0) this.byAsker.set(from, rest);
				else this.byAsker.delete(from);
				this.options.changed(from, rest.map((question) => question.to));
				resolve(result);
			};
			const onAbort = () => done({ ok: false, error: "Stopped waiting for a reply." });
			const timer = setTimeout(() => done({
				ok: false,
				error: `No reply from ${to} within ${Math.round(replyTimeoutMs / 60_000)} min. Continue with your best judgment and say so in your report.`,
			}), replyTimeoutMs);
			const pending: Pending = {
				to,
				resolve: (reply) => done({ ok: true, delivered: "replied", reply }),
				reject: (error) => done({ ok: false, error: error.message }),
			};
			const open = [...this.of(from), pending];
			this.byAsker.set(from, open);
			this.options.changed(from, open.map((question) => question.to));
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}
}
