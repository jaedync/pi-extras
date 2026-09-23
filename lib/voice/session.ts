/**
 * One dictation, from key press to final text. Recording starts before the
 * daemon is reachable: frames are buffered and replayed on attach, so a cold
 * daemon never loses the first words.
 */
import { isClipped, levelFromPcm, type ChunkView, type IndicatorState } from "./indicator.ts";
import { pcmToBase64, type ClientMessage, type DaemonEvent } from "./protocol.ts";

export interface SessionTransport {
	send(message: ClientMessage): void;
}

export interface SessionOptions {
	readonly id: number;
	readonly now: () => number;
	readonly onChange: (view: IndicatorState) => void;
	/** How long a stopped dictation waits for the next sign of progress. */
	readonly finalTimeoutMs?: number;
	/** The same wait while the daemon is still loading the model. */
	readonly loadTimeoutMs?: number;
}

export const SAMPLE_RATE = 16_000;
const LEVEL_HISTORY = 64;
const DEFAULT_FINAL_TIMEOUT_MS = 30_000;
// A cold load of the largest CPU model has taken tens of seconds on slow disks; this only catches a hung one.
const DEFAULT_LOAD_TIMEOUT_MS = 5 * 60_000;
const LOADING_MESSAGE = "loading the speech model";
// Before any chunk has been timed: well under what every backend measured (13x to 90x realtime).
const DEFAULT_DECODE_SPEED = 20;
const DECODE_OVERHEAD_MS = 50;
// First-run setup can take minutes; past this the recording stops rather than grow without bound (~9.6 MB).
export const MAX_BUFFERED_MS = 5 * 60_000;
// -57 dBFS: far below any working mic's room noise (-43 dBFS measured on a MacBook Pro), above digital near-silence.
const QUIET_LEVEL = 0.05;
const QUIET_AFTER_MS = 3000;

export class DictationSession {
	readonly id: number;
	private readonly options: SessionOptions;
	private transport?: SessionTransport;
	private buffered: Int16Array[] = [];
	private segments: ChunkView[] = [];
	private filling?: ChunkView;
	private readonly texts = new Map<number, string>();
	private readonly audioMs = new Map<number, number>();
	private readonly decodeStartedAt = new Map<number, number>();
	private timedAudioMs = 0;
	private timedDecodeMs = 0;
	private stopRequested = false;
	private settled = false;
	private resolveFinal?: (text: string) => void;
	private rejectFinal?: (error: Error) => void;
	private finalPromise?: Promise<string>;
	private failure?: Error;
	private timer?: ReturnType<typeof setTimeout>;
	private model: "unknown" | "loading" | "ready" = "unknown";
	private capturedMs = 0;
	private heard = false;
	view: IndicatorState;

	constructor(options: SessionOptions) {
		this.id = options.id;
		this.options = options;
		this.view = { phase: "connecting", startedAt: options.now(), levels: [], speaking: false, chunks: [], queuedMs: 0 };
	}

	get active(): boolean {
		return !this.settled;
	}

	/** Setup has held MAX_BUFFERED_MS of audio; further frames are dropped until the daemon attaches. */
	get bufferFull(): boolean {
		return !this.transport && this.view.queuedMs >= MAX_BUFFERED_MS;
	}

	pushFrame(frame: Int16Array): void {
		if (this.stopRequested || this.settled || this.bufferFull) return;
		const level = levelFromPcm(frame);
		const frameMs = (frame.length / SAMPLE_RATE) * 1000;
		const levels = [...this.view.levels, level].slice(-LEVEL_HISTORY);
		const clipped = isClipped(frame) ? { clippedAt: this.options.now() } : {};
		const quiet = this.quietAfter(level, frameMs);
		if (this.transport) {
			this.transport.send({ t: "audio", id: this.id, pcm: pcmToBase64(frame) });
			this.update({ levels, ...clipped, ...quiet });
			return;
		}
		this.buffered.push(frame.slice());
		this.update({ levels, ...clipped, ...quiet, queuedMs: this.view.queuedMs + frameMs });
	}

	/** Flags a mic that has delivered nothing audible yet; the first audible frame clears it for good. */
	private quietAfter(level: number, frameMs: number): Partial<IndicatorState> {
		this.capturedMs += frameMs;
		if (this.heard) return {};
		if (level >= QUIET_LEVEL) {
			this.heard = true;
			return this.view.quiet === undefined ? {} : { quiet: false };
		}
		return this.capturedMs >= QUIET_AFTER_MS ? { quiet: true } : {};
	}

	/** A short explanation shown on the row, e.g. why recording stopped by itself. */
	note(message: string): void {
		this.update({ message });
	}

	setDevice(device: string): void {
		this.update({ device });
	}

	attach(transport: SessionTransport): void {
		if (this.transport || this.settled) return;
		this.transport = transport;
		transport.send({ t: "start", id: this.id });
		for (const frame of this.buffered) transport.send({ t: "audio", id: this.id, pcm: pcmToBase64(frame) });
		this.buffered = [];
		if (this.stopRequested) {
			transport.send({ t: "stop", id: this.id });
			this.armTimeout();
		}
		this.update({ queuedMs: 0, phase: this.stopRequested ? "finishing" : "recording" });
	}

	stop(): Promise<string> {
		if (this.finalPromise) return this.finalPromise;
		this.finalPromise = new Promise<string>((resolve, reject) => {
			this.resolveFinal = resolve;
			this.rejectFinal = reject;
		});
		if (this.failure) {
			this.settle(this.failure);
			return this.finalPromise;
		}
		this.stopRequested = true;
		if (this.transport) {
			this.transport.send({ t: "stop", id: this.id });
			this.armTimeout();
		}
		this.update({ phase: "finishing", stoppedAt: this.options.now(), speaking: false, ...this.loadingNote() });
		return this.finalPromise;
	}

	cancel(): void {
		if (this.settled) return;
		this.transport?.send({ t: "cancel", id: this.id });
		this.settle(new Error("cancelled"));
		this.update({ phase: "cancelled", stoppedAt: this.view.stoppedAt ?? this.options.now(), speaking: false });
	}

	/** Connection lost or daemon unusable: fail now rather than wait for the timeout. */
	fail(message: string): void {
		if (this.settled) return;
		this.failure = new Error(message);
		this.settle(this.failure);
		this.update({ phase: "error", message, stoppedAt: this.view.stoppedAt ?? this.options.now(), speaking: false });
	}

	handleEvent(event: DaemonEvent): void {
		if (this.settled) return;
		if ("id" in event && event.id !== undefined && event.id !== this.id) return;
		// Any sign of life restarts the wait, so a long dictation is not held to one deadline.
		if (this.timer) this.armTimeout();
		switch (event.t) {
			case "status":
				this.onStatus(event.state, event.backend, event.model);
				return;
			case "vad":
				this.filling = event.speaking ? (this.filling ?? { state: "filling", openedAt: this.options.now() }) : undefined;
				this.update({ speaking: event.speaking && !this.stopRequested });
				return;
			case "chunk":
				this.onChunk(event.index, event.state, event.ms, event.text);
				return;
			case "final":
				this.settle(event.text);
				this.update({ phase: "inserted" });
				return;
			case "error":
				this.fail(event.message);
		}
	}

	private onStatus(state: "loading" | "ready", backend?: string, model?: string): void {
		const patch = { ...(backend ? { backend } : {}), ...(model ? { model } : {}) };
		this.model = state;
		if (this.timer) this.armTimeout();
		if (this.stopRequested) return this.update({ ...patch, ...this.loadingNote() });
		this.update({ ...patch, phase: state === "loading" ? "loading" : "recording" });
	}

	/** Transcript of the finished chunks up to the first unfinished one; a prefix of the final text. */
	readyText(): string {
		const parts: string[] = [];
		for (let index = 0; this.texts.has(index); index++) {
			const text = this.texts.get(index)!;
			if (text) parts.push(text);
		}
		return parts.join(" ");
	}

	/** Predicted time until every chunk is decoded, from pending audio and measured decode speed. */
	estimateWaitMs(): number {
		const now = this.options.now();
		let pending = 0;
		this.segments.forEach((segment, index) => {
			if (segment && segment.state !== "done") pending += this.audioMs.get(index) ?? Math.max(0, now - segment.openedAt);
		});
		if (this.filling) pending += Math.max(0, (this.view.stoppedAt ?? now) - this.filling.openedAt);
		const speed = this.timedDecodeMs > 0 ? this.timedAudioMs / this.timedDecodeMs : DEFAULT_DECODE_SPEED;
		return Math.round(pending / speed + DECODE_OVERHEAD_MS);
	}

	private recordChunk(index: number, state: "queued" | "decoding" | "done", ms?: number, text?: string): void {
		if (ms !== undefined) this.audioMs.set(index, ms);
		if (state === "decoding") this.decodeStartedAt.set(index, this.options.now());
		if (state !== "done") return;
		this.texts.set(index, (text ?? "").trim());
		const started = this.decodeStartedAt.get(index);
		const audio = this.audioMs.get(index);
		if (started !== undefined && audio !== undefined) {
			this.timedAudioMs += audio;
			this.timedDecodeMs += Math.max(1, this.options.now() - started);
		}
	}

	private onChunk(index: number, state: "queued" | "decoding" | "done", ms?: number, text?: string): void {
		this.recordChunk(index, state, ms, text);
		const previous = this.segments[index];
		const openedAt = previous?.openedAt ?? this.filling?.openedAt ?? this.options.now();
		const segments = [...this.segments];
		segments[index] = { state, openedAt };
		this.segments = segments;
		// A segment queued while still speaking was a forced split; the speech continues in a new chunk.
		if (!previous && state === "queued") {
			this.filling = this.view.speaking ? { state: "filling", openedAt: this.options.now() } : undefined;
		}
		this.update({});
	}

	/** After stop, says why the wait is long, and clears that once the model is ready. */
	private loadingNote(): Partial<IndicatorState> {
		if (this.model === "loading") return { message: LOADING_MESSAGE };
		return this.view.message === LOADING_MESSAGE ? { message: undefined } : {};
	}

	/**
	 * Only counts once the daemon has the audio; first-time setup can take much longer.
	 * Decoding waits behind a model load, so until the daemon reports ready the load cap applies.
	 */
	private armTimeout(): void {
		clearTimeout(this.timer);
		const loading = this.model !== "ready";
		const ms = loading ? (this.options.loadTimeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS) : (this.options.finalTimeoutMs ?? DEFAULT_FINAL_TIMEOUT_MS);
		const message = loading ? "the speech model did not finish loading; see /voice status" : "transcription timed out";
		this.timer = setTimeout(() => this.fail(message), ms);
		this.timer.unref?.();
	}

	private settle(outcome: string | Error): void {
		if (this.settled) return;
		this.settled = true;
		clearTimeout(this.timer);
		this.buffered = [];
		if (!this.finalPromise) {
			// Nobody is waiting yet; keep the outcome for a later stop().
			this.finalPromise = typeof outcome === "string" ? Promise.resolve(outcome) : Promise.reject(outcome);
			void this.finalPromise.catch(() => {});
			return;
		}
		if (typeof outcome === "string") this.resolveFinal?.(outcome);
		else this.rejectFinal?.(outcome);
	}

	private update(patch: Partial<IndicatorState>): void {
		const chunks = this.filling ? [...this.segments.filter(Boolean), this.filling] : this.segments.filter(Boolean);
		this.view = { ...this.view, ...patch, chunks };
		this.options.onChange(this.view);
	}
}
