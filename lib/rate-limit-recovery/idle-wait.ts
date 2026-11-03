/**
 * A local server's wait while the session is idle. The failed run ends, so auto-update can
 * reload or restart Pi, shell jobs report, and the user can type; when the server answers, one
 * custom message starts the run again. The open wait is a session entry, so a reload or an
 * update restart picks it up where it stopped.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { waitUntilAnswering, type LocalWaitEnd } from "./local.ts";
import type { Wait } from "./wait.ts";

/** The custom message that starts the run again; before_agent_start keeps the outage for it. */
export const LOCAL_RESUME_TYPE = "rate-limit-recovery-local-resume";
// A session opened days later must not start a run on its own.
export const RESTORE_MAX_AGE_MS = 48 * 3600_000;

export interface IdleLocalWait {
	readonly who: string;
	readonly baseUrl: string;
	readonly delayMs: number;
	/** When the server stopped answering, for the live line. */
	readonly sinceMs: number;
}

export interface LocalWaitEntry {
	readonly kind: "local-wait";
	readonly state: "open" | "closed";
	readonly who: string;
	readonly baseUrl: string;
	readonly sinceMs: number;
	readonly at: number;
	readonly end?: LocalWaitEnd;
}

type Ui = { tick(): void; close(): void } | undefined;

export interface IdleWaitDeps {
	/** Starts the run again: pi.sendMessage(..., { triggerTurn: true }). */
	readonly resume: (content: string, details: LocalWaitEntry) => void;
	readonly record: (entry: LocalWaitEntry) => void;
	readonly probe: (baseUrl: string, signal: AbortSignal) => Promise<boolean>;
	readonly wait: Wait;
	readonly now: () => number;
	readonly ui?: (ctx: ExtensionContext, who: string, sinceMs: number, cancel: () => void) => Ui;
	/** The backoff's bookkeeping: an answered check counts toward its limit of failures in a row. */
	readonly ended?: (who: string, end: LocalWaitEnd, ranMs: number) => void;
	readonly onFailure?: (error: unknown) => void;
}

/** The last local-wait entry on the branch when it is still open and recent enough to go on. */
export function openWait(entries: ReadonlyArray<{ type: string; customType?: string; data?: unknown }>, type: string, now: number): LocalWaitEntry | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry?.type !== "custom" || entry.customType !== type) continue;
		const data = entry.data as Partial<LocalWaitEntry> | undefined;
		if (data?.kind !== "local-wait") continue;
		const valid = data.state === "open" && typeof data.who === "string" && typeof data.baseUrl === "string"
			&& typeof data.sinceMs === "number" && typeof data.at === "number" && now - data.at < RESTORE_MAX_AGE_MS;
		return valid ? data as LocalWaitEntry : undefined;
	}
	return undefined;
}

const SWITCHED_TEXT = "The model changed during the wait for the local server. Continue the task from where it stopped.";

export function resumeText(who: string): string {
	return `The local model server ${who} answers again. Continue the task from where it stopped.`;
}

export class LocalIdleWait {
	private readonly deps: IdleWaitDeps;
	private active: { readonly controller: AbortController; readonly entry: LocalWaitEntry } | undefined;

	constructor(deps: IdleWaitDeps) { this.deps = deps; }

	get waiting(): boolean { return this.active !== undefined; }

	/** Wait for the server while idle. The open entry is written first, so a reload finds it. */
	start(ctx: ExtensionContext, wait: IdleLocalWait): void {
		this.stop();
		const entry: LocalWaitEntry = { kind: "local-wait", state: "open", who: wait.who, baseUrl: wait.baseUrl, sinceMs: wait.sinceMs, at: this.deps.now() };
		this.safe(() => this.deps.record(entry));
		void this.run(ctx, entry, wait.delayMs);
	}

	/** After a reload or an update restart: go on with an open wait from the branch. */
	restore(ctx: ExtensionContext, entry: LocalWaitEntry): void {
		this.stop();
		void this.run(ctx, entry, 0);
	}

	/** The user ends the wait (Esc, a new message, another model): no run starts. */
	cancel(): void {
		const active = this.active;
		if (!active) return;
		this.active = undefined;
		this.safe(() => this.deps.record({ ...active.entry, state: "closed", end: "cancelled", at: this.deps.now() }));
		active.controller.abort();
	}

	/** The user switched to another model: the run goes on at once with it. */
	skip(model: string): void {
		const active = this.active;
		if (!active || active.entry.who === model) return;
		this.active = undefined;
		const closed: LocalWaitEntry = { ...active.entry, state: "closed", end: "cancelled", at: this.deps.now() };
		this.safe(() => this.deps.record(closed));
		active.controller.abort();
		this.safe(() => this.deps.resume(SWITCHED_TEXT, closed));
	}

	/** Shutdown or reload: the wait stops here, and its entry stays open for the next module. */
	stop(): void {
		const active = this.active;
		this.active = undefined;
		active?.controller.abort();
	}

	private async run(ctx: ExtensionContext, entry: LocalWaitEntry, delayMs: number): Promise<void> {
		const controller = new AbortController();
		this.active = { controller, entry };
		const started = this.deps.now();
		let ui: Ui;
		let end: LocalWaitEnd = "cancelled";
		try {
			ui = this.deps.ui?.(ctx, entry.who, entry.sinceMs, () => this.cancel());
			end = await waitUntilAnswering({
				delayMs, signal: controller.signal, tick: () => ui?.tick(), now: this.deps.now, wait: this.deps.wait,
				probe: (signal) => this.deps.probe(entry.baseUrl, signal),
			});
		} catch (error) {
			this.deps.onFailure?.(error);
			end = "cancelled";
		} finally {
			this.safe(() => ui?.close());
		}
		// Another start, a stop or a cancel took over: that one decides what happens next.
		if (end === "cancelled" || controller.signal.aborted || this.active?.controller !== controller) return;
		this.active = undefined;
		const closed: LocalWaitEntry = { ...entry, state: "closed", end, at: this.deps.now() };
		this.safe(() => this.deps.ended?.(entry.who, end, this.deps.now() - started));
		this.safe(() => this.deps.record(closed));
		this.safe(() => this.deps.resume(resumeText(entry.who), closed));
	}

	private safe(fn: () => void): void {
		try { fn(); } catch (error) { this.deps.onFailure?.(error); }
	}
}
