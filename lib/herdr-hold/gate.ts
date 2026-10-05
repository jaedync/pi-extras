/**
 * Decides when Herdr's own Pi integration may report `idle`. Herdr plays its
 * "done" sound the moment a pane goes from working to idle, and its integration
 * reports idle when main's turn settles, even while subagents or shell jobs
 * still run. The gate holds that one report until the background work ends and
 * then replays Herdr's own bytes, so the integration stays Herdr's code.
 */
import type { BackgroundWork } from "../tab-status/events.ts";

/** Herdr's integration source; only Herdr's own Pi reports are gated. */
export const HERDR_PI_SOURCE = "herdr:pi";
/** A completion message usually starts a new turn within this window; replaying idle first would chime twice. */
export const RELEASE_GRACE_MS = 2000;
// Herdr's requests are one short JSON line; anything larger is not one of them.
const MAX_REPORT_BYTES = 64 * 1024;

export interface HerdrReport {
	readonly id: string;
	readonly method: string;
	readonly state?: string;
}

export type Verdict = "pass" | "hold";

export interface GateOptions {
	readonly paneId: string;
	/** Sends held bytes to Herdr, bypassing the gate. */
	readonly send: (bytes: string) => void;
	readonly graceMs?: number;
	readonly setTimer?: (run: () => void, ms: number) => unknown;
	readonly clearTimer?: (timer: unknown) => void;
}

function chunkText(chunk: unknown): string | undefined {
	if (typeof chunk === "string") return chunk;
	if (chunk instanceof Uint8Array) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString("utf8");
	return undefined;
}

/** Herdr's own Pi report for this pane, or undefined for every other write. */
export function readReport(chunk: unknown, paneId: string): HerdrReport | undefined {
	const text = chunkText(chunk);
	if (!text || text.length > MAX_REPORT_BYTES) return undefined;
	let value: unknown;
	try { value = JSON.parse(text); } catch { return undefined; }
	if (!value || typeof value !== "object") return undefined;
	const { id, method, params } = value as { id?: unknown; method?: unknown; params?: unknown };
	if (typeof method !== "string" || !params || typeof params !== "object") return undefined;
	const { source, pane_id: pane, state } = params as { source?: unknown; pane_id?: unknown; state?: unknown };
	if (source !== HERDR_PI_SOURCE || pane !== paneId) return undefined;
	return { id: typeof id === "string" ? id : "", method, state: typeof state === "string" ? state : undefined };
}

/** The reply Herdr would send, so the integration's request settles at once. */
export function ackFor(report: HerdrReport): string {
	return `${JSON.stringify({ id: report.id, result: { type: "ok" } })}\n`;
}

export class Gate {
	private readonly options: GateOptions;
	private sessionId: string | undefined;
	private counts = new Map<BackgroundWork["source"], number>();
	private rateWait = false;
	private held: string | undefined;
	private timer: unknown;

	constructor(options: GateOptions) { this.options = options; }

	get paneId(): string { return this.options.paneId; }

	/** Counts belong to one session; a new session starts with none until its sources report. */
	setSession(sessionId: string): void {
		if (sessionId !== this.sessionId) {
			this.sessionId = sessionId;
			this.counts = new Map();
			this.rateWait = false;
		}
		this.update();
	}

	background(work: BackgroundWork): void {
		if (work.sessionId !== this.sessionId) return;
		this.counts = new Map(this.counts).set(work.source, work.count);
		this.update();
	}

	rateLimitWait(sessionId: string, active: boolean): void {
		if (sessionId !== this.sessionId) return;
		this.rateWait = active;
		this.update();
	}

	busy(): boolean {
		return this.rateWait || [...this.counts.values()].some((count) => count > 0);
	}

	holding(): boolean { return this.held !== undefined; }

	/** Called for each write to Herdr's socket. Only an idle report during background work is held. */
	write(chunk: unknown): Verdict {
		const report = readReport(chunk, this.options.paneId);
		// Session reports carry no state; every state report supersedes the held idle.
		if (!report || report.method !== "pane.report_agent") return "pass";
		this.cancel();
		if (report.state === "idle" && this.busy()) {
			this.held = chunkText(chunk);
			return "hold";
		}
		this.held = undefined;
		return "pass";
	}

	/** A new turn makes Herdr report working, which replaces the held idle. */
	turnStarted(): void { this.cancel(); }

	/** Replays the held idle now; used when no extension remains to release it later. */
	flush(): void {
		this.cancel();
		const held = this.held;
		this.held = undefined;
		if (held !== undefined) this.options.send(held);
	}

	/** Drops the held idle without sending it; Herdr notices an exited agent by itself. */
	drop(): void {
		this.cancel();
		this.held = undefined;
	}

	private update(): void {
		if (this.busy()) this.cancel();
		else if (this.held !== undefined && this.timer === undefined) {
			const set = this.options.setTimer ?? ((run, ms) => { const t = setTimeout(run, ms); t.unref(); return t; });
			this.timer = set(() => { this.timer = undefined; if (!this.busy()) this.flush(); }, this.options.graceMs ?? RELEASE_GRACE_MS);
		}
	}

	private cancel(): void {
		if (this.timer === undefined) return;
		(this.options.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>)))(this.timer);
		this.timer = undefined;
	}
}
